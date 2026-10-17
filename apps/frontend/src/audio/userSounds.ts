// My Sounds: library sounds people made or changed in the Sound Designer,
// kept in this browser (IndexedDB) across projects.

import { findSound, CATEGORY_NAMES, type SoundRecipe } from '@noprod/sound';
import { reportStorageError, clearStorageIssue, requestPersistence } from '../project/storage';

let sounds: SoundRecipe[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeUserSounds = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getUserSounds = () => sounds;

// A built-in sound or one of mine, by id
export const findAnySound = (id: string): SoundRecipe | undefined => findSound(id) ?? sounds.find((s) => s.id === id);

// IndexedDB "noprod-sounds" v2: { id, version: SOUNDS_VERSION, recipe }.
// v1 stored the bare recipes; the upgrade wraps them.
export const SOUNDS_VERSION = 1;
const DB = 'noprod-sounds';
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, 2);
  req.onupgradeneeded = (e) => {
    const db = req.result;
    if (e.oldVersion < 1) db.createObjectStore('sounds', { keyPath: 'id' });
    if (e.oldVersion === 1) {
      const cursor = req.transaction!.objectStore('sounds').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        if (!('recipe' in c.value)) c.update({ id: c.value.id, version: 1, recipe: c.value });
        c.continue();
      };
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
// Resolves once the write is committed, so a full disk is an error here
const tx = async (mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => {
  const db = await openDb();
  return new Promise<any>((resolve, reject) => {
    const t = db.transaction('sounds', mode);
    const req = fn(t.objectStore('sounds'));
    t.oncomplete = () => resolve(req.result);
    t.onabort = t.onerror = () => reject(t.error ?? req.error);
  });
};

const byName = (a: SoundRecipe, b: SoundRecipe) => a.name.localeCompare(b.name);

export async function loadUserSounds() {
  if (loaded) return;
  loaded = true;
  try {
    const records: { version: number; recipe: SoundRecipe }[] = await tx('readonly', (s) => s.getAll());
    // Sounds a newer NoProd saved stay stored, but aren't shown
    sounds = records.filter((r) => r.version <= SOUNDS_VERSION && !recipeProblem(r.recipe)).map((r) => r.recipe).sort(byName);
    emit();
  } catch (err) {
    reportStorageError('My Sounds', err);
  }
}

// Saves (or replaces, by id) one of my sounds. If storage fails it's kept
// for this session, reported, and the promise rejects.
export async function saveUserSound(recipe: SoundRecipe) {
  sounds = [...sounds.filter((s) => s.id !== recipe.id), recipe].sort(byName);
  emit();
  try {
    await tx('readwrite', (s) => s.put({ id: recipe.id, version: SOUNDS_VERSION, recipe }));
    clearStorageIssue('My Sounds');
    requestPersistence();
  } catch (err) {
    reportStorageError('My Sounds', err);
    throw err;
  }
}

export async function deleteUserSound(id: string) {
  sounds = sounds.filter((s) => s.id !== id);
  emit();
  try { await tx('readwrite', (s) => s.delete(id)); } catch (err) { reportStorageError('My Sounds', err); }
}

// ---- export and import: { format: 'noprod-sounds', version, sounds: SoundRecipe[] }

const EXPORT_FORMAT = 'noprod-sounds';
const LAYER_TYPES = ['partials', 'wave', 'fm', 'noise', 'model'];
const MAX_IMPORT_BYTES = 16 << 20;

export function exportUserSounds() {
  const json = JSON.stringify({ format: EXPORT_FORMAT, version: SOUNDS_VERSION, sounds }, null, 1);
  return { blob: new Blob([json], { type: 'application/json' }), count: sounds.length };
}

// What makes this not a recipe the renderer can take, or null
function recipeProblem(r: any): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r.id !== 'string' || !r.id) return 'no id';
  if (typeof r.name !== 'string') return 'no name';
  if (!(r.category in CATEGORY_NAMES)) return `unknown category ${JSON.stringify(r.category)}`;
  if (typeof r.pitched !== 'boolean') return 'pitched must be true or false';
  if (typeof r.length !== 'number' || !(r.length > 0 && r.length <= 60)) return 'length must be 0–60 seconds';
  if (!Array.isArray(r.layers) || !r.layers.length) return 'no layers';
  const bad = r.layers.find((l: any) => !l || typeof l !== 'object' || !LAYER_TYPES.includes(l.type));
  return bad ? `a layer of unknown type ${JSON.stringify(bad?.type)}` : null;
}

// Adds the sounds in an export to My Sounds (replacing ones with the same
// id); refuses the whole file if any sound is malformed. Returns how many.
export async function importUserSounds(file: Blob): Promise<number> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a sounds export');
  let doc: any;
  try { doc = JSON.parse(await file.text()); } catch { throw new Error('That file is not a sounds export (not JSON)'); }
  if (!doc || doc.format !== EXPORT_FORMAT || !Array.isArray(doc.sounds)) throw new Error('That file is not a NoProd sounds export');
  if (typeof doc.version !== 'number' || doc.version > SOUNDS_VERSION) throw new Error(`Those sounds were exported by a newer NoProd (v${doc.version})`);
  doc.sounds.forEach((r: any, i: number) => {
    const problem = recipeProblem(r);
    if (problem) throw new Error(`Sound ${i + 1}${typeof r?.name === 'string' ? ` (“${r.name}”)` : ''}: ${problem}`);
  });
  // Mine never take a built-in sound's id
  const recipes: SoundRecipe[] = doc.sounds.map((r: SoundRecipe) => (findSound(r.id) ? { ...r, id: `my-${r.id}` } : r));
  for (const r of recipes) await saveUserSound(r);
  return recipes.length;
}
