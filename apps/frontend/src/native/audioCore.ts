// Client for the Audio Core's native plugin host (apps/audio_core, GhostDAW),
// over its own WebSocket to GhostDAW's control server: the address in
// Services (services.ts), paired with the token pairing.ts keeps. GhostDAW
// hosts per-track and master insert chains of VST3 / AU / LPI plugins; this
// module mirrors those chains and sends them commands (see
// apps/audio_core/src/host/PluginHost.h). The connection exists while the
// GhostDAW service is on; with a token it is paired at once, without one
// (or with one GhostDAW refuses) a tokenless connection is kept open so the
// user can PAIR with the code GhostDAW printed.

import { hidePluginEditor, showPluginEditor } from './pluginEditor';
import { getServices, serviceHost, subscribeServices } from './services';
import { approveNativePlugin } from './consent';
import { getPairingToken, setPairingToken, withPairingToken } from './pairing';
import { backoffMs } from './backoff';

export interface NativeParameter {
  index: number;
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  value: number;
  text: string;
  stepped: boolean;
  boolean: boolean;
  readOnly: boolean;
}

export interface NativeInsert {
  slotId: string;
  name: string;
  format: string;
  path: string;
  pluginId?: string;
  bypassed: boolean;
  latencySamples: number;
  parameters: NativeParameter[];
  hasEditor?: boolean;  // an editor the Audio Core can stream (LPI plug-ins with a GUI)
  editorOpen?: boolean;
}

export interface NativePlugin {
  name: string;
  vendor: string;
  format: string;
  path: string;
  pluginId: string;    // what GhostDAW loads by: an LPI plug-in's own id, a VST 3 class UID, an AU's codes
}

export interface SkippedPlugin {
  path: string;
  reason: string;      // crashed or hung while loading, or did not survive a scan
}

// 'master', or a track number (= the orbit whose haps play on it)
export type NativeBusId = 'master' | number;

export interface NativeBus {
  bus: NativeBusId;
  inserts: NativeInsert[];
}

export interface AudioCoreState {
  protocolVersion?: number;
  sampleRate: number;
  blockSize: number;
  trackCount: number;
  device?: { name: string; running: boolean };
  streamPort?: number;         // where browser tracks stream their audio through plug-ins
  buses: NativeBus[];          // the master bus, then track buses that have inserts
  availablePlugins: NativePlugin[];
  skippedPlugins?: SkippedPlugin[];
  scanFolders: string[];
  scanning?: boolean;
}

// The Audio Core's copy of a plug-in the browser found by name: the browser
// only sees paths inside the folder it was given, the Audio Core knows the
// plug-in by its id.
export const findNativePlugin = (name: string): NativePlugin | null => {
  const wanted = name.trim().toLowerCase().replace(/\.(vst3|component|dll|so|dylib|lpi)$/, '');
  return snapshot.state?.availablePlugins.find((p) => p.name.toLowerCase() === wanted) ?? null;
};

// A track device that the Audio Core hosts through the native bridge
// (the user choosing the plug-in is their consent to load it, consent.ts)
export const nativeDeviceFor = (p: NativePlugin) => {
  const device = { name: p.name, type: 'vst', pluginPath: p.path, format: p.format, pluginId: p.pluginId, parameters: {} };
  approveNativePlugin(device);
  return device;
};

// The id GhostDAW loads a device's plug-in by. A device from before ids
// (a path only) gets its id from the scanned list, once that matches it.
export const nativePluginIdOf = (device: any): string | null => {
  if (typeof device?.pluginId === 'string' && device.pluginId) return device.pluginId;
  if (typeof device?.pluginPath !== 'string' || !device.pluginPath) return null;
  return snapshot.state?.availablePlugins.find((p) => p.path === device.pluginPath)?.pluginId ?? null;
};

export const busInserts = (state: AudioCoreState | null, bus: NativeBusId): NativeInsert[] =>
  state?.buses.find((b) => b.bus === bus)?.inserts ?? [];

// Applies a change to one insert, wherever it lives
const mapInsert = (state: AudioCoreState, slotId: string, fn: (ins: NativeInsert) => NativeInsert): AudioCoreState => ({
  ...state,
  buses: state.buses.map((b) => ({ ...b, inserts: b.inserts.map((ins) => (ins.slotId === slotId ? fn(ins) : ins)) }))
});

interface Snapshot {
  connected: boolean;        // paired and talking to GhostDAW
  state: AudioCoreState | null;
  busy: string | null;       // the command we're waiting on (scan / load)
  error: string | null;
  // GhostDAW is reachable but this browser isn't paired with it (no token,
  // or one it refused): the panel asks for the code GhostDAW printed
  needsPairing: boolean;
  pairing: boolean;          // a PAIR is on its way
  pairingError: string | null;
}

let snapshot: Snapshot = { connected: false, state: null, busy: null, error: null, needsPairing: false, pairing: false, pairingError: null };
let socket: WebSocket | null = null;
let openUrl = '';            // the service address the connection was opened for
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let warnedBadMessage = false;
const listeners = new Set<() => void>();
const pairedListeners = new Set<(token: string) => void>();

// A patch that changes nothing is dropped: a retry every few seconds while
// GhostDAW is away must not re-render every subscriber (the sidebar is one)
const update = (patch: Partial<Snapshot>) => {
  if ((Object.keys(patch) as (keyof Snapshot)[]).every((key) => Object.is(snapshot[key], patch[key]))) return;
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((fn) => fn());
};

export const subscribeAudioCore = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getAudioCore = () => snapshot;
// Fires with the token once pairing succeeds (the stream sockets reopen with it)
export const onAudioCorePaired = (fn: (token: string) => void) => { pairedListeners.add(fn); return () => { pairedListeners.delete(fn); }; };

// Where a browser track streams its audio: GhostDAW's host and the stream
// port it announced, with the token. Null until both are known.
export const nativeStreamUrl = (): string | null => {
  const port = snapshot.state?.streamPort;
  const token = getPairingToken();
  if (!port || !token) return null;
  return withPairingToken(`ws://${serviceHost('ghostdaw')}:${port}`, token);
};

function stop() {
  if (retry) { clearTimeout(retry); retry = null; }
  const ws = socket;
  socket = null;
  if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); }
  update({ connected: false, busy: null, needsPairing: false, pairing: false });
}

const scheduleRetry = () => {
  retry = setTimeout(() => { retry = null; if (getServices().ghostdaw.enabled) connect(getPairingToken()); }, backoffMs(attempt++));
};

function connect(token: string | null) {
  const base = getServices().ghostdaw.url;
  openUrl = base;
  let ws: WebSocket;
  try {
    ws = new WebSocket(withPairingToken(base, token));
  } catch (err) {
    // Safari throws a SecurityError for ws:// from an https page: a failed attempt, not a crash
    console.warn('Could not open the GhostDAW connection', err);
    scheduleRetry();
    return;
  }
  socket = ws;
  let opened = false;
  let tokenRefused = false; // GhostDAW answered "not paired" to a connection that had a token: it is stale
  ws.onopen = () => {
    opened = true;
    attempt = 0;
    if (token) {
      update({ connected: true, needsPairing: false, pairing: false, pairingError: null, error: null });
      ws.send(JSON.stringify({ type: 'GET_AUDIO_CORE_STATE' }));
    } else {
      update({ connected: false, needsPairing: true, pairing: false, error: null });
    }
  };
  ws.onmessage = (event) => {
    let msg: any;
    try { msg = JSON.parse(event.data); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      if (!warnedBadMessage) { warnedBadMessage = true; console.warn('Ignoring a message from GhostDAW that is not a typed JSON object'); }
      return;
    }
    if (token && msg.type === 'AUDIO_CORE_ERROR' && /not paired/.test(String(msg.message))) tokenRefused = true;
    handleMessage(msg);
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    if (socket !== ws) return; // a stale socket closing late mustn't drop its replacement
    socket = null;
    const wasConnected = snapshot.connected;
    update({ connected: false, busy: null, pairing: false });
    if (!getServices().ghostdaw.enabled) return;
    // A token GhostDAW refused is dropped at the handshake (the browser sees
    // a close before open), or, on the control server, admitted as unpaired
    // and told so at its first command: either way try without one; if
    // that opens, GhostDAW is up and this browser must pair again. A
    // tokenless connection that closes means GhostDAW is away: retry in a
    // while.
    if (token && ((!opened && !wasConnected) || tokenRefused)) {
      setPairingToken(null);
      connect(null);
      return;
    }
    if (!opened) update({ needsPairing: false });
    scheduleRetry();
  };
}

// Follows the GhostDAW service: connects when it is on, drops the
// connection when it is off, reconnects at a changed address
function follow() {
  const g = getServices().ghostdaw;
  if (!g.enabled) { stop(); attempt = 0; return; }
  if (socket && openUrl === g.url) return;
  if (!socket && retry && openUrl === g.url) return; // waiting out a backoff
  stop();
  attempt = 0;
  connect(getPairingToken());
}

subscribeServices(follow);
follow();

// Sends the code GhostDAW printed; PAIRED brings the token
export function pairAudioCore(code: string) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    update({ pairingError: 'GhostDAW is not reachable' });
    return;
  }
  update({ pairing: true, pairingError: null });
  ws.send(JSON.stringify({ type: 'PAIR', code: code.trim() }));
}

// Forgets the token; the next connection asks for a code again
export function unpairAudioCore() {
  setPairingToken(null);
  stop();
  attempt = 0;
  if (getServices().ghostdaw.enabled) connect(null);
}

const send = (message: Record<string, unknown>) => {
  if (!socket || socket.readyState !== WebSocket.OPEN || !snapshot.connected) {
    update({ error: snapshot.needsPairing ? 'Not paired with GhostDAW' : 'GhostDAW offline' });
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
};

function handleMessage(msg: any) {
  switch (msg.type) {
    case 'PAIRED': {
      const token: string = msg.token;
      setPairingToken(token);
      // The connection that paired is itself paired from now on
      update({ connected: true, needsPairing: false, pairing: false, pairingError: null, error: null });
      pairedListeners.forEach((fn) => fn(token));
      send({ type: 'GET_AUDIO_CORE_STATE' });
      return;
    }
    case 'PAIR_FAILED':
      update({
        pairing: false,
        pairingError: msg.locked
          ? 'Pairing is locked until GhostDAW restarts (too many wrong codes)'
          : `Wrong code, ${msg.attemptsLeft} attempt${msg.attemptsLeft === 1 ? '' : 's'} left`
      });
      return;
    case 'AUDIO_CORE_STATE': {
      const state = { ...msg };
      delete state.type;
      update({ state: state as AudioCoreState, connected: true, busy: null, error: null });
      return;
    }
    case 'PLUGIN_PARAMETER_CHANGED': {
      const st = snapshot.state;
      if (!st) return;
      update({
        state: mapInsert(st, msg.slotId, (ins) => ({
          ...ins,
          parameters: ins.parameters.map((p) => p.index === msg.parameterIndex ? { ...p, value: msg.value, text: msg.text } : p)
        }))
      });
      return;
    }
    case 'EDITOR_OPENED':
      showPluginEditor(msg, () => send({ type: 'CLOSE_EDITOR' }), snapshot.connected);
      return;
    case 'EDITOR_CLOSED':
      hidePluginEditor(msg.editorId);
      return;
    case 'AUDIO_CORE_ERROR':
      update({ error: msg.message, busy: null });
      return;
    default:
      return;
  }
}

if (import.meta.env.DEV) (window as any).__audioCore = getAudioCore;

// ---------------------------------------------------------------- commands

export const refreshAudioCore = () => send({ type: 'GET_AUDIO_CORE_STATE' });

// GhostDAW scans the platform's plug-in folders and those in its own
// settings (ghostdaw --add-scan-folder DIR), never folders a page names
export function scanNativePlugins() {
  if (send({ type: 'SCAN_PLUGINS' })) update({ busy: 'scan', error: null });
}

// Plug-ins load by their id from availablePlugins, never by path
export function loadNativePlugin(plugin: Pick<NativePlugin, 'pluginId'>, bus: NativeBusId = 'master') {
  if (send({ type: 'LOAD_PLUGIN', pluginId: plugin.pluginId, bus }))
    update({ busy: 'load', error: null });
}

export const removeNativePlugin = (slotId: string) => send({ type: 'REMOVE_PLUGIN', slotId });
export const moveNativePlugin = (slotId: string, index: number) => send({ type: 'MOVE_PLUGIN', slotId, index });
export const setNativeBypass = (slotId: string, bypassed: boolean) => send({ type: 'SET_PLUGIN_BYPASS', slotId, bypassed });
// The reply, EDITOR_OPENED, shows it (pluginEditor.ts)
export const openNativeEditor = (slotId: string) => send({ type: 'OPEN_EDITOR', slotId });

// Slider drags produce many changes; send at most one per parameter per frame.
const pendingParams = new Map<string, { slotId: string; parameterIndex: number; value: number }>();
let flushScheduled = false;

export function setNativeParameter(slotId: string, parameterIndex: number, value: number) {
  pendingParams.set(`${slotId}:${parameterIndex}`, { slotId, parameterIndex, value });
  // Show the new position straight away; the Audio Core's reply brings its text
  const st = snapshot.state;
  if (st) {
    update({
      state: mapInsert(st, slotId, (ins) => ({
        ...ins,
        parameters: ins.parameters.map((p) => p.index === parameterIndex ? { ...p, value } : p)
      }))
    });
  }
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    pendingParams.forEach((p) => send({ type: 'SET_PLUGIN_PARAMETER', ...p }));
    pendingParams.clear();
  });
}
