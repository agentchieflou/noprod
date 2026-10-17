// Browser storage problems, told to the user instead of swallowed: autosave,
// My Sounds and the plug-in list report here, notify() announces each, and
// the File menu shows the latest. Also asks once for persistent storage, so
// the browser won't evict what's kept here (Safari does after a week without
// a visit).

import { notify } from '../notify';

export interface StorageIssue {
  what: string;    // which store: "Autosave", "My Sounds", …
  message: string; // shown as is
}

let issue: StorageIssue | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeStorageIssue = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getStorageIssue = () => issue;

export function describeStorageError(err: unknown): string {
  const name = (err as any)?.name;
  if (name === 'QuotaExceededError') return 'browser storage is full';
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError' || name === 'NotFoundError') {
    return 'browser storage is unavailable (a private window, or site data blocked?)';
  }
  return `the write failed (${(err as any)?.message || err})`;
}

// Shown as a notice when it starts, and as a banner until that store
// writes again (autosave retries on every edit, so it isn't noticed each time)
export function reportStorageError(what: string, err: unknown) {
  console.warn(`${what}:`, err);
  const message = `${what}: ${describeStorageError(err)}`;
  if (issue?.message !== message) notify(message, 'error');
  issue = { what, message };
  emit();
}

// A store that works again clears its own report
export function clearStorageIssue(what?: string) {
  if (!issue || (what && issue.what !== what)) return;
  issue = null;
  emit();
}

let persistAsked = false;
export function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => { /* not granted: nothing to tell */ });
}
