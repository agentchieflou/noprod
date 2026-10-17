// The user's own API key for AI dictation (#157). It lives in this browser's
// localStorage under one entry and nowhere else: not in a project, an
// autosave or an export, and it is sent only to the provider's host
// (provider.ts).

export const KEY_ENTRY = 'noprod.dictation.gemini-key';

let current = '';
try { current = localStorage.getItem(KEY_ENTRY) ?? ''; } catch { /* no storage: the key lasts until reload */ }
const listeners = new Set<() => void>();

export const subscribeKey = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getKey = () => current;
export const hasKey = () => current !== '';

// An empty (or blank) key forgets it
export function setKey(key: string) {
  const next = key.trim();
  if (next === current) return;
  current = next;
  try {
    if (next) localStorage.setItem(KEY_ENTRY, next);
    else localStorage.removeItem(KEY_ENTRY);
  } catch { /* private window: lasts until reload */ }
  listeners.forEach((fn) => fn());
}

export const forgetKey = () => setKey('');

// The settings dialog is opened from the dictation box
let dialogOpen = false;
const dialogListeners = new Set<() => void>();
export const subscribeKeyDialog = (fn: () => void) => { dialogListeners.add(fn); return () => { dialogListeners.delete(fn); }; };
export const getKeyDialogOpen = () => dialogOpen;
export const setKeyDialogOpen = (open: boolean) => { dialogOpen = open; dialogListeners.forEach((fn) => fn()); };
