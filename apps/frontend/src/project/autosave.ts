// Crash/close recovery: each tab keeps its unsaved project in a slot of its
// own in IndexedDB, one per tab and project, written by the project worker.
// Audio goes in once per buffer; later autosaves send only project.json and
// any new buffers (a take just recorded), so they're cheap even mid-playback.
//
// A tab's id lives in sessionStorage (it survives a reload) and is held as a
// Web Lock while the tab is open: slots whose lock is free belong to closed
// or crashed tabs, and are offered for recovery. A duplicated tab copies
// sessionStorage, finds the lock taken, and picks a new id.

import { v4 as uuidv4 } from 'uuid';
import { createDefaultProject } from '../store/useDAWStore';
import { callWorker, snapshotProject, toPcm, pcmTransfer } from './projectFile';
import type { ProjectDoc } from './schema';
import { reportStorageError } from './storage';
import type { Pcm } from './format';

export interface RecoveryCopy {
  key: string;
  tabId: string;  // '' for the single copy older NoProds kept
  projectId: string;
  name: string;
  savedAt: number;
}

const TAB_KEY = 'noprod-tab';
const lockName = (tabId: string) => `noprod-tab:${tabId}`;

let tabId = '';
let projectId = uuidv4();
let written = new Set<string>(); // buffer ids the current slot already holds

// Holds this tab's lock for as long as the tab lives; false if it's taken
const holdLock = (id: string) => new Promise<boolean>((resolve) => {
  navigator.locks.request(lockName(id), { ifAvailable: true }, (lock) => {
    resolve(!!lock);
    return lock ? new Promise<void>(() => {}) : undefined;
  }).catch(() => resolve(true));
});

let ready: Promise<void> | null = null;
const claimTab = () => {
  ready ??= (async () => {
    let id = '';
    try { id = sessionStorage.getItem(TAB_KEY) || ''; } catch { /* no sessionStorage: a new id each load */ }
    if (!id) id = uuidv4();
    if (navigator.locks) while (!(await holdLock(id))) id = uuidv4();
    tabId = id;
    try { sessionStorage.setItem(TAB_KEY, id); } catch { /* as above */ }
  })();
  return ready;
};

const slotKey = (id = projectId) => `${tabId}:${id}`;

// A new project in this tab (New, Open, Restore) gets a slot of its own
export function startProject(id = uuidv4()) {
  projectId = id;
  written = new Set();
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

// Writes the project into this tab's slot. Throws storage errors. The slot
// is the one current when called, even if a new project starts meanwhile.
export function writeAutosave(state: any) {
  const id = projectId;
  const have = written;
  return serial(async () => {
    await claimTab();
    const key = slotKey(id);
    const { json, buffers } = snapshotProject(state);
    const fresh = [...buffers].filter(([id]) => !have.has(id)).map(([id, buf]) => ({ id, pcm: toPcm(buf) }));
    await callWorker('autosave', {
      meta: { key, tabId, projectId: id, name: state.projectName, savedAt: Date.now() },
      json, bufferIds: [...buffers.keys()], fresh
    }, pcmTransfer(fresh.map((f) => f.pcm)));
    fresh.forEach((f) => have.add(f.id));
  });
}

// The current project was saved or discarded: its recovery copy goes
export const clearAutosave = () => {
  const id = projectId;
  return serial(async () => {
    await claimTab();
    if (id === projectId) written = new Set();
    await callWorker('drop', { key: slotKey(id) });
  }).catch(() => undefined);
};

export const dropRecoveryCopy = (key: string) => serial(() => callWorker('drop', { key })).catch(() => undefined);

// Unsaved work this tab can recover: its own (after a reload) and that of
// tabs that are no longer open
export async function listRecoveryCopies(): Promise<RecoveryCopy[]> {
  await claimTab();
  const copies = await callWorker<RecoveryCopy[]>('slots');
  let held = new Set<string>();
  try { if (navigator.locks) held = new Set(((await navigator.locks.query()).held ?? []).map((l) => l.name!)); } catch { /* treat all as closed */ }
  return copies
    .filter((c) => c.key !== slotKey() && (c.tabId === tabId || !held.has(lockName(c.tabId))))
    .sort((a, b) => b.savedAt - a.savedAt);
}

// A recovery copy's project, checked and migrated like a file
export async function readRecoveryCopy(copy: RecoveryCopy) {
  return callWorker<{ doc: ProjectDoc; pcm: Pcm[] }>('restore', { key: copy.key, defaults: createDefaultProject() });
}

// After restoring `copy`, this tab carries on in the copy's slot when it was
// this tab's; otherwise the copy moves into this tab's own slot
export async function adoptRecoveryCopy(copy: RecoveryCopy, state: any) {
  await claimTab();
  if (copy.tabId === tabId) { startProject(copy.projectId); return; }
  startProject();
  try {
    await writeAutosave(state);
  } catch (err) {
    reportStorageError('Autosave', err);
    return; // the copy stays where it is until this tab's slot holds it
  }
  await dropRecoveryCopy(copy.key);
}
