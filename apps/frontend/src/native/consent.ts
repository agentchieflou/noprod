// Native plug-ins are code on the user's machine, so a project file can't
// make GhostDAW load them by itself. A device with a `pluginPath` loads only
// when GhostDAW is on and the user has agreed to that path: by picking the
// plug-in themselves (nativeDeviceFor), or by answering the question a
// project with native devices asks when it opens. The answer is kept per
// project in this browser, never in the project file.

import { isNativeDevice, refreshNativeDevices } from './trackBridge';
import { getServices, subscribeServices } from './services';

export interface PendingNativeLoad {
  project: string;
  plugins: { name: string; path: string }[];
}

const KEY = 'noprod.nativeConsent';
const approved = new Set<string>(); // paths, this session
let pending: PendingNativeLoad | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeNativeConsent = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPendingNativeLoad = () => pending;

export const nativeLoadAllowed = (device: any) => getServices().ghostdaw.enabled && approved.has(device.pluginPath);

export function approveNativePath(path: string) {
  if (approved.has(path)) return;
  approved.add(path);
  refreshNativeDevices();
}

const signature = (project: string, paths: string[]) => JSON.stringify([project, [...paths].sort()]);

const readAnswers = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
};
const writeAnswer = (sig: string, yes: boolean) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readAnswers(), [sig]: yes })); } catch { /* not remembered */ }
};

const flattenDevices = (plugins: any[]): any[] => plugins.flatMap((p) => (p.type === 'rack' ? p.devices || [] : [p]));

// The native devices of the project's chains that haven't been agreed to
function unapproved(state: any): { name: string; path: string }[] {
  const chains = [state.masterPlugins, ...(state.returns || []).map((r: any) => r.plugins), ...(state.tracks || []).map((t: any) => t.plugins)];
  const found = new Map<string, string>();
  chains.forEach((plugins) => flattenDevices(plugins || []).forEach((d) => {
    if (isNativeDevice(d) && !approved.has(d.pluginPath) && !found.has(d.pluginPath)) found.set(d.pluginPath, d.name);
  }));
  return [...found].map(([path, name]) => ({ name, path }));
}

export function answerNativeLoad(yes: boolean) {
  if (!pending) return;
  const { project, plugins } = pending;
  const paths = plugins.map((p) => p.path);
  pending = null;
  writeAnswer(signature(project, paths), yes);
  if (yes) paths.forEach(approveNativePath);
  emit();
}

// Asks (once per project and set of plug-ins) when a project that is open
// wants native plug-ins and GhostDAW is on
export function watchNativeConsent(store: { getState(): any; subscribe(fn: () => void): () => void }) {
  let signatureAsked = '';
  const check = () => {
    const state = store.getState();
    if (!getServices().ghostdaw.enabled) return;
    const wanted = unapproved(state);
    if (!wanted.length) { if (pending) { pending = null; emit(); } return; }
    const project = state.projectName || 'Untitled';
    const sig = signature(project, wanted.map((p) => p.path));
    if (sig === signatureAsked) return;
    signatureAsked = sig;
    const answer = readAnswers()[sig];
    if (answer === true) { wanted.forEach((p) => approveNativePath(p.path)); return; }
    if (answer === false) return;
    pending = { project, plugins: wanted };
    emit();
  };
  check();
  subscribeServices(check);
  return store.subscribe(check);
}
