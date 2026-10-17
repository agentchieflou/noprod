// Native plug-ins are code on the user's machine, so a project file can't
// make GhostDAW load them by itself. A native device loads only when
// GhostDAW is on and the user has agreed to that plug-in: by picking it
// themselves (nativeDeviceFor), or by answering the question a project with
// native devices asks when it opens. The answer is kept per project in this
// browser, never in the project file.
//
// A plug-in is known by its id (what GhostDAW loads by: an LPI plug-in's own
// id, a VST 3 class UID, an AU's codes), which is the same wherever it is
// installed. A device from before ids carries only a path; it is known by
// that until the scanned list gives it an id.

import { isNativeDevice, refreshNativeDevices } from './trackBridge';
import { getAudioCore, nativePluginIdOf, subscribeAudioCore } from './audioCore';
import { getServices, subscribeServices } from './services';

export interface PendingNativePlugin {
  key: string;
  name: string;
  path: string;
  pluginId: string | null;
}

export interface PendingNativeLoad {
  project: string;
  plugins: PendingNativePlugin[];
}

const KEY = 'noprod.nativeConsent';
const approved = new Set<string>(); // plug-in keys, this session
let pending: PendingNativeLoad | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeNativeConsent = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPendingNativeLoad = () => pending;

// What a device's plug-in is agreed to by: its id, else its path
export const nativeKey = (device: any): string | null => {
  const id = nativePluginIdOf(device);
  if (id) return id;
  return typeof device?.pluginPath === 'string' && device.pluginPath ? `path:${device.pluginPath}` : null;
};

export const nativeLoadAllowed = (device: any) => {
  const key = nativeKey(device);
  return getServices().ghostdaw.enabled && key !== null && approved.has(key);
};

function approveKey(key: string) {
  if (approved.has(key)) return;
  approved.add(key);
  refreshNativeDevices();
}

export function approveNativePlugin(device: any) {
  const key = nativeKey(device);
  if (key) approveKey(key);
}

const signature = (project: string, keys: string[]) => JSON.stringify([project, [...keys].sort()]);

const readAnswers = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
};
const writeAnswer = (sig: string, yes: boolean) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readAnswers(), [sig]: yes })); } catch { /* not remembered */ }
};

const flattenDevices = (plugins: any[]): any[] => plugins.flatMap((p) => (p.type === 'rack' ? p.devices || [] : [p]));

// The path a plug-in is installed at, from the scanned list where it has
// the id (that is where the file is), else what the device says
const pathOf = (device: any, pluginId: string | null) => {
  const scanned = pluginId ? getAudioCore().state?.availablePlugins.find((p) => p.pluginId === pluginId) : null;
  return scanned?.path ?? (typeof device?.pluginPath === 'string' ? device.pluginPath : '');
};

// The native devices of the project's chains that haven't been agreed to
function unapproved(state: any): PendingNativePlugin[] {
  const chains = [state.masterPlugins, ...(state.returns || []).map((r: any) => r.plugins), ...(state.tracks || []).map((t: any) => t.plugins)];
  const found = new Map<string, PendingNativePlugin>();
  chains.forEach((plugins) => flattenDevices(plugins || []).forEach((d) => {
    if (!isNativeDevice(d)) return;
    const key = nativeKey(d);
    if (!key || approved.has(key) || found.has(key)) return;
    const pluginId = nativePluginIdOf(d);
    found.set(key, { key, name: d.name, path: pathOf(d, pluginId), pluginId });
  }));
  return [...found.values()];
}

// An answer from before ids was keyed by the plug-ins' paths. It carries
// over when every path maps to exactly one scanned id (the one the
// plug-in has now); otherwise the project asks again.
function migratedAnswer(project: string, wanted: PendingNativePlugin[]): boolean | null {
  const devicesPaths = wanted.map((p) => p.path);
  if (devicesPaths.some((p) => !p)) return null;
  const old = readAnswers()[signature(project, devicesPaths)];
  if (old !== true) return null;
  const scanned = getAudioCore().state?.availablePlugins ?? [];
  return wanted.every((p) => p.pluginId && scanned.filter((s) => s.path === p.path).length === 1 && scanned.find((s) => s.path === p.path)?.pluginId === p.pluginId) ? true : null;
}

export function answerNativeLoad(yes: boolean) {
  if (!pending) return;
  const { project, plugins } = pending;
  const keys = plugins.map((p) => p.key);
  pending = null;
  writeAnswer(signature(project, keys), yes);
  if (yes) keys.forEach(approveKey);
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
    const sig = signature(project, wanted.map((p) => p.key));
    if (sig === signatureAsked) return;
    signatureAsked = sig;
    const answer = readAnswers()[sig] ?? migratedAnswer(project, wanted);
    if (answer === true) { writeAnswer(sig, true); wanted.forEach((p) => approveKey(p.key)); return; }
    if (answer === false) return;
    pending = { project, plugins: wanted };
    emit();
  };
  check();
  subscribeServices(check);
  subscribeAudioCore(check); // the scanned list gives devices from before ids their ids
  return store.subscribe(check);
}
