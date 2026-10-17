// The project worker: writes and reads .noprod files, and keeps the autosave
// slots in IndexedDB, so none of it runs on the main thread. Requests are
// handled one at a time, in the order they arrive (an autosave sent before a
// "drop" never lands after it).
//
// IndexedDB "noprod" v2:
//   slots     { key: `${tabId}:${projectId}`, tabId, projectId, name, savedAt, json }
//   pcm       [slot key, buffer id] -> { sampleRate, channels: Float32Array[] }
//   autosave  v1's single recovery copy ('current' -> { blob, name, savedAt }),
//             offered once and then dropped

import { writeProjectFile, readProjectFile, checkDoc, ProjectFileError, type Pcm } from './format.ts';

// v1's recovery copy is listed under this key, with no tab
const LEGACY_KEY = 'legacy';

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === 'undefined') { reject(new DOMException('IndexedDB is not available', 'InvalidStateError')); return; }
  const req = indexedDB.open('noprod', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('autosave')) db.createObjectStore('autosave');
    if (!db.objectStoreNames.contains('slots')) db.createObjectStore('slots', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('pcm')) db.createObjectStore('pcm');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new DOMException('An older NoProd tab is holding storage; close it and reload', 'InvalidStateError'));
});

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () => {
  dbPromise ??= openDb().catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
};

// Runs `fn` in one transaction; resolves with its result once committed
async function transact<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction, done: (v: T) => void) => void) {
  const tx = (await db()).transaction(stores, mode);
  return new Promise<T>((resolve, reject) => {
    let result: T;
    fn(tx, (v) => { result = v; });
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new DOMException('The write was aborted', 'AbortError'));
  });
}

const slotRange = (key: string) => IDBKeyRange.bound([key], [key, []]);

interface SlotMeta { key: string; tabId: string; projectId: string; name: string; savedAt: number }

const ops: Record<string, (a: any) => Promise<{ result?: unknown; transfer?: Transferable[] }>> = {
  async write({ json, pcm }) {
    return { result: await writeProjectFile(json, pcm) };
  },

  async read({ blob, defaults }) {
    const { doc, pcm } = await readProjectFile(blob, defaults);
    return { result: { doc, pcm }, transfer: pcmTransfer(pcm) };
  },

  // Writes the slot and the buffers it doesn't have yet, and drops the
  // buffers it no longer uses, all or nothing
  async autosave({ meta, json, bufferIds, fresh }) {
    await transact<void>(['slots', 'pcm'], 'readwrite', (tx) => {
      const pcm = tx.objectStore('pcm');
      fresh.forEach((f: { id: string; pcm: Pcm }) => pcm.put(f.pcm, [meta.key, f.id]));
      tx.objectStore('slots').put({ ...meta, json });
      const keep = new Set(bufferIds);
      const keys = pcm.getAllKeys(slotRange(meta.key));
      keys.onsuccess = () => keys.result.forEach((k: any) => { if (!keep.has(k[1])) pcm.delete(k); });
    });
    return {};
  },

  async slots() {
    const list = await transact<SlotMeta[]>(['slots', 'autosave'], 'readonly', (tx, done) => {
      const out: SlotMeta[] = [];
      const cursor = tx.objectStore('slots').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { const { key, tabId, projectId, name, savedAt } = c.value; out.push({ key, tabId, projectId, name, savedAt }); c.continue(); return; }
        const legacy = tx.objectStore('autosave').get('current');
        legacy.onsuccess = () => {
          const r = legacy.result;
          if (r?.blob) out.push({ key: LEGACY_KEY, tabId: '', projectId: '', name: r.name, savedAt: r.savedAt });
          done(out);
        };
      };
    });
    return { result: list };
  },

  async restore({ key, defaults }) {
    if (key === LEGACY_KEY) {
      const rec = await transact<any>(['autosave'], 'readonly', (tx, done) => {
        const r = tx.objectStore('autosave').get('current');
        r.onsuccess = () => done(r.result);
      });
      if (!rec?.blob) throw new ProjectFileError('That recovery copy is gone');
      return ops.read({ blob: rec.blob, defaults });
    }
    const { slot, stored } = await transact<{ slot: any; stored: Map<string, Pcm> }>(['slots', 'pcm'], 'readonly', (tx, done) => {
      const s = tx.objectStore('slots').get(key);
      const stored = new Map<string, Pcm>();
      const c = tx.objectStore('pcm').openCursor(slotRange(key));
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) { stored.set((cur.key as any)[1], cur.value); cur.continue(); return; }
        done({ slot: s.result, stored });
      };
    });
    if (!slot) throw new ProjectFileError('That recovery copy is gone');
    let raw: unknown;
    try { raw = JSON.parse(slot.json); } catch { throw new ProjectFileError('That recovery copy is damaged'); }
    const doc = checkDoc(raw, defaults);
    const pcm = doc.buffers.map((b) => {
      const p = stored.get(b.id);
      if (!p || p.channels.length !== b.channels || p.channels.some((c) => c.length !== b.length)) {
        throw new ProjectFileError('That recovery copy is missing some of its audio');
      }
      return p;
    });
    return { result: { doc, pcm }, transfer: pcmTransfer(pcm) };
  },

  async drop({ key }) {
    if (key === LEGACY_KEY) {
      await transact<void>(['autosave'], 'readwrite', (tx) => { tx.objectStore('autosave').delete('current'); });
      return {};
    }
    await transact<void>(['slots', 'pcm'], 'readwrite', (tx) => {
      tx.objectStore('slots').delete(key);
      tx.objectStore('pcm').delete(slotRange(key));
    });
    return {};
  }
};

const pcmTransfer = (pcm: Pcm[]) => [...new Set(pcm.flatMap((p) => p.channels.map((c) => c.buffer as ArrayBuffer)))];

let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent) => {
  const { id, op, args } = e.data;
  queue = queue.then(async () => {
    try {
      const { result, transfer = [] } = await ops[op](args);
      (self as any).postMessage({ id, ok: true, result }, transfer);
    } catch (err: any) {
      (self as any).postMessage({ id, ok: false, error: { name: err?.name || 'Error', message: err?.message || String(err) } });
    }
  });
};
