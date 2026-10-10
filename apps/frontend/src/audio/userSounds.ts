// My Sounds: library sounds people made or changed in the Sound Designer,
// kept in this browser (IndexedDB) across projects.

import { findSound, type SoundRecipe } from '@noprod/sound';

let sounds: SoundRecipe[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeUserSounds = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getUserSounds = () => sounds;

// A built-in sound or one of mine, by id
export const findAnySound = (id: string): SoundRecipe | undefined => findSound(id) ?? sounds.find((s) => s.id === id);

const DB = 'noprod-sounds';
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore('sounds', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const tx = async (mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => {
  const db = await openDb();
  return new Promise<any>((resolve, reject) => {
    const req = fn(db.transaction('sounds', mode).objectStore('sounds'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export async function loadUserSounds() {
  if (loaded) return;
  loaded = true;
  try {
    sounds = ((await tx('readonly', (s) => s.getAll())) as SoundRecipe[]).sort((a, b) => a.name.localeCompare(b.name));
    emit();
  } catch { /* IndexedDB unavailable: sounds last until the page closes */ }
}

// Saves (or replaces, by id) one of my sounds
export async function saveUserSound(recipe: SoundRecipe) {
  sounds = [...sounds.filter((s) => s.id !== recipe.id), recipe].sort((a, b) => a.name.localeCompare(b.name));
  emit();
  try { await tx('readwrite', (s) => s.put(recipe)); } catch { /* kept for this session */ }
}

export async function deleteUserSound(id: string) {
  sounds = sounds.filter((s) => s.id !== id);
  emit();
  try { await tx('readwrite', (s) => s.delete(id)); } catch { /* gone for this session */ }
}
