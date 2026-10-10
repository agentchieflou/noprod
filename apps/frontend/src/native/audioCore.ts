// Client for the Audio Core's native plugin host (apps/audio_core, GhostDAW),
// reached through the Orchestrator's WebSocket. GhostDAW renders the
// Sequencer's patterns one track per Strudel orbit, through per-track and
// master insert chains of VST3 / AU / LPI plugins; this module mirrors those
// chains and sends them commands (see apps/audio_core/src/PluginHost.h).

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
  bypassed: boolean;
  latencySamples: number;
  parameters: NativeParameter[];
}

export interface NativePlugin {
  name: string;
  vendor: string;
  format: string;
  path: string;
  pluginId: string;
}

// 'master', or a track number (= the Strudel orbit whose haps play on it)
export type NativeBusId = 'master' | number;

export interface NativeBus {
  bus: NativeBusId;
  inserts: NativeInsert[];
}

export interface AudioCoreState {
  sampleRate: number;
  blockSize: number;
  trackCount: number;
  device?: { name: string; running: boolean };
  buses: NativeBus[];          // the master bus, then track buses that have inserts
  availablePlugins: NativePlugin[];
  scanFolders: string[];
}

export const busInserts = (state: AudioCoreState | null, bus: NativeBusId): NativeInsert[] =>
  state?.buses.find((b) => b.bus === bus)?.inserts ?? [];

// Applies a change to one insert, wherever it lives
const mapInsert = (state: AudioCoreState, slotId: string, fn: (ins: NativeInsert) => NativeInsert): AudioCoreState => ({
  ...state,
  buses: state.buses.map((b) => ({ ...b, inserts: b.inserts.map((ins) => (ins.slotId === slotId ? fn(ins) : ins)) }))
});

interface Snapshot {
  connected: boolean;        // the Orchestrator reports the Audio Core is reachable
  state: AudioCoreState | null;
  busy: string | null;       // the command we're waiting on (scan / load)
  error: string | null;
}

let snapshot: Snapshot = { connected: false, state: null, busy: null, error: null };
let socket: WebSocket | null = null;
const listeners = new Set<() => void>();

const update = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((fn) => fn());
};

export const subscribeAudioCore = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getAudioCore = () => snapshot;

// The Orchestrator connection is owned by App; it hands it over here.
export function attachOrchestrator(ws: WebSocket) {
  socket = ws;
}

// Only the socket that's attached can detach (a stale socket closing late
// mustn't drop its replacement)
export function detachOrchestrator(ws: WebSocket) {
  if (socket !== ws) return;
  socket = null;
  update({ connected: false, busy: null });
}

const send = (message: Record<string, unknown>) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    update({ error: 'Orchestrator offline' });
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
};

// Returns true when the message belonged to the Audio Core
export function handleOrchestratorMessage(msg: any): boolean {
  switch (msg?.type) {
    case 'AUDIO_CORE_STATUS':
      update({ connected: !!msg.connected, ...(msg.connected ? {} : { busy: null }) });
      if (msg.connected) send({ type: 'GET_AUDIO_CORE_STATE' });
      return true;
    case 'AUDIO_CORE_STATE': {
      const state = { ...msg };
      delete state.type;
      update({ state: state as AudioCoreState, connected: true, busy: null, error: null });
      return true;
    }
    case 'PLUGIN_PARAMETER_CHANGED': {
      const st = snapshot.state;
      if (!st) return true;
      update({
        state: mapInsert(st, msg.slotId, (ins) => ({
          ...ins,
          parameters: ins.parameters.map((p) => p.index === msg.parameterIndex ? { ...p, value: msg.value, text: msg.text } : p)
        }))
      });
      return true;
    }
    case 'AUDIO_CORE_ERROR':
      update({ error: msg.message, busy: null });
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- commands

export const refreshAudioCore = () => send({ type: 'GET_AUDIO_CORE_STATE' });

export function scanNativePlugins(paths: string[]) {
  if (send({ type: 'SCAN_PLUGINS', paths })) update({ busy: 'scan', error: null });
}

export function loadNativePlugin(plugin: Pick<NativePlugin, 'path' | 'format'> & { pluginId?: string }, bus: NativeBusId = 'master') {
  if (send({ type: 'LOAD_PLUGIN', path: plugin.path, format: plugin.format, pluginId: plugin.pluginId, bus }))
    update({ busy: 'load', error: null });
}

export const removeNativePlugin = (slotId: string) => send({ type: 'REMOVE_PLUGIN', slotId });
export const moveNativePlugin = (slotId: string, index: number) => send({ type: 'MOVE_PLUGIN', slotId, index });
export const setNativeBypass = (slotId: string, bypassed: boolean) => send({ type: 'SET_PLUGIN_BYPASS', slotId, bypassed });

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
