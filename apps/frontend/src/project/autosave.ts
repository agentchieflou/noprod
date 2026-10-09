// Crash/close recovery: the latest unsaved project is kept in IndexedDB
// (projects with audio quickly outgrow localStorage's ~5MB).

const DB = 'noprod';
const STORE = 'autosave';
const KEY = 'current';

export interface AutosaveRecord {
  blob: Blob;
  name: string;
  savedAt: number;
}

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export const writeAutosave = (rec: AutosaveRecord) => run('readwrite', (s) => s.put(rec, KEY));
export const readAutosave = () => run<AutosaveRecord | undefined>('readonly', (s) => s.get(KEY)).catch(() => undefined);
export const clearAutosave = () => run('readwrite', (s) => s.delete(KEY)).catch(() => undefined);
