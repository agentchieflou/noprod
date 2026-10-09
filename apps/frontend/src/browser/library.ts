// The Browser's file library: user folders ("Places") and the audio files
// inside them. Folders picked with the File System Access API are kept as
// directory handles in IndexedDB so they come back after a reload (the
// browser may ask to confirm access once per session); elsewhere a
// webkitdirectory pick works for the current session.

import { audioContext } from '../audio/engine';

export interface LibraryFile {
  id: string;           // `${placeId}:${path}`
  name: string;
  path: string;         // relative to the place
  placeId: string;
}

export interface LibraryFolder {
  name: string;
  path: string;
  folders: LibraryFolder[];
  files: LibraryFile[];
}

export interface Place {
  id: string;
  name: string;
  status: 'ready' | 'needs-permission' | 'scanning' | 'error';
  root: LibraryFolder | null;
}

const AUDIO_EXT = /\.(wav|wave|mp3|ogg|oga|m4a|aac|flac|aif|aiff|webm)$/i;
const MAX_FILES = 5000;
const MAX_DEPTH = 8;

const handles = new Map<string, any>();          // placeId -> FileSystemDirectoryHandle
const fileGetters = new Map<string, () => Promise<File>>();
let places: Place[] = [];
const listeners = new Set<() => void>();
const emit = () => { places = [...places]; listeners.forEach((fn) => fn()); };
export const subscribeLibrary = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPlaces = () => places;

// ------------------------------------------------------------ persistence

const DB = 'noprod-library';
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore('places', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const tx = async (mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => {
  const db = await openDb();
  return new Promise<any>((resolve, reject) => {
    const req = fn(db.transaction('places', mode).objectStore('places'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export async function loadPlaces() {
  try {
    const saved: { id: string; name: string; handle: any }[] = await tx('readonly', (s) => s.getAll());
    for (const rec of saved) {
      handles.set(rec.id, rec.handle);
      places.push({ id: rec.id, name: rec.name, status: 'needs-permission', root: null });
    }
    emit();
    for (const p of places) {
      const perm = await handles.get(p.id)?.queryPermission?.({ mode: 'read' });
      if (perm === 'granted') scanPlace(p.id);
    }
  } catch { /* IndexedDB unavailable: places just aren't remembered */ }
}

// ---------------------------------------------------------------- scanning

async function scanHandle(dir: any, path: string, placeId: string, depth: number, count: { n: number }): Promise<LibraryFolder> {
  const folder: LibraryFolder = { name: dir.name, path, folders: [], files: [] };
  if (depth > MAX_DEPTH) return folder;
  for await (const entry of dir.values()) {
    if (count.n >= MAX_FILES) break;
    const p = path ? `${path}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      const sub = await scanHandle(entry, p, placeId, depth + 1, count);
      if (sub.files.length || sub.folders.length) folder.folders.push(sub);
    } else if (AUDIO_EXT.test(entry.name)) {
      const id = `${placeId}:${p}`;
      fileGetters.set(id, () => entry.getFile());
      folder.files.push({ id, name: entry.name, path: p, placeId });
      count.n++;
    }
  }
  folder.folders.sort((a, b) => a.name.localeCompare(b.name));
  folder.files.sort((a, b) => a.name.localeCompare(b.name));
  return folder;
}

export async function scanPlace(placeId: string) {
  const place = places.find((p) => p.id === placeId);
  const handle = handles.get(placeId);
  if (!place || !handle) return;
  place.status = 'scanning';
  emit();
  try {
    place.root = await scanHandle(handle, '', placeId, 0, { n: 0 });
    place.status = 'ready';
  } catch {
    place.status = 'error';
  }
  emit();
}

// Re-grant access to a remembered folder (needs a click)
export async function reconnectPlace(placeId: string) {
  const handle = handles.get(placeId);
  const perm = await handle?.requestPermission?.({ mode: 'read' });
  if (perm === 'granted') await scanPlace(placeId);
}

export async function addPlace(): Promise<void> {
  const picker = (window as any).showDirectoryPicker;
  if (picker) {
    let handle: any;
    try { handle = await picker.call(window, { mode: 'read' }); } catch { return; } // cancelled
    const id = `place-${Date.now()}`;
    handles.set(id, handle);
    places.push({ id, name: handle.name, status: 'scanning', root: null });
    emit();
    try { await tx('readwrite', (s) => s.put({ id, name: handle.name, handle })); } catch { /* not persisted */ }
    await scanPlace(id);
    return;
  }
  // Fallback: a directory <input> (this session only)
  const input = document.createElement('input');
  input.type = 'file';
  (input as any).webkitdirectory = true;
  input.multiple = true;
  await new Promise<void>((resolve) => {
    input.onchange = () => {
      const files = [...(input.files || [])].filter((f) => AUDIO_EXT.test(f.name));
      if (!files.length) { resolve(); return; }
      const id = `place-${Date.now()}`;
      const rootName = ((files[0] as any).webkitRelativePath || files[0].name).split('/')[0];
      const root: LibraryFolder = { name: rootName, path: '', folders: [], files: [] };
      files.slice(0, MAX_FILES).forEach((f) => {
        const parts = ((f as any).webkitRelativePath || f.name).split('/').slice(1);
        let folder = root;
        parts.slice(0, -1).forEach((name: string, i: number) => {
          const path = parts.slice(0, i + 1).join('/');
          let sub = folder.folders.find((x) => x.name === name);
          if (!sub) { sub = { name, path, folders: [], files: [] }; folder.folders.push(sub); }
          folder = sub;
        });
        const path = parts.join('/');
        const fid = `${id}:${path}`;
        fileGetters.set(fid, async () => f);
        folder.files.push({ id: fid, name: f.name, path, placeId: id });
      });
      places.push({ id, name: rootName, status: 'ready', root });
      emit();
      resolve();
    };
    input.click();
  });
}

export async function removePlace(placeId: string) {
  places = places.filter((p) => p.id !== placeId);
  handles.delete(placeId);
  emit();
  try { await tx('readwrite', (s) => s.delete(placeId)); } catch { /* ignore */ }
}

// Every audio file across all places
export function allFiles(): LibraryFile[] {
  const out: LibraryFile[] = [];
  const walk = (f: LibraryFolder) => { out.push(...f.files); f.folders.forEach(walk); };
  places.forEach((p) => p.root && walk(p.root));
  return out;
}

// -------------------------------------------------------- loading / preview

const decoded = new Map<string, AudioBuffer>();

export async function getFile(fileId: string): Promise<File | null> {
  const get = fileGetters.get(fileId);
  return get ? get() : null;
}

export async function decodeLibraryFile(fileId: string): Promise<AudioBuffer> {
  const cached = decoded.get(fileId);
  if (cached) return cached;
  const file = await getFile(fileId);
  if (!file) throw new Error('File is no longer available');
  if (audioContext.state === 'suspended') await audioContext.resume();
  const buf = await audioContext.decodeAudioData(await file.arrayBuffer());
  decoded.set(fileId, buf);
  return buf;
}

// Preview plays straight to the speakers, bypassing tracks and the master chain
let previewSource: AudioBufferSourceNode | null = null;
const previewGain = audioContext.createGain();
previewGain.gain.value = 0.8;
previewGain.connect(audioContext.destination);

export async function previewFile(fileId: string) {
  stopPreview();
  const buf = await decodeLibraryFile(fileId);
  previewSource = audioContext.createBufferSource();
  previewSource.buffer = buf;
  previewSource.connect(previewGain);
  previewSource.start();
}

export function stopPreview() {
  try { previewSource?.stop(); } catch { /* not started */ }
  previewSource = null;
}
