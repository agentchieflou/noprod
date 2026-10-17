// Native plugins (VST3 / AU / LPI) on the browser's own tracks, hosted by
// the Audio Core (#26). A track device with a `pluginPath` becomes a
// native-insert worklet: its audio streams to GhostDAW's stream server
// (apps/audio_core/src/host/TrackStreams.h) through a bridge worker and comes
// back processed after a fixed latency, which the engine compensates for
// on the other tracks.
//
// Device objects look like
//   { id, name, type: 'vst', pluginId, pluginPath, format, parameters: { [parameterId]: value } }
// (pluginId is what GhostDAW loads by; the path is for showing) and keep
// their parameter values by the plugin's own parameter ids, so a project
// reloads them into the plugin. Changes made in the plug-in's own
// editor (#44 B6) come back to the device through onNativeEditorParameter.

import type { DeviceDSP, ParamValue } from '../audio/devices';
import { nativePluginIdOf, nativeStreamUrl, subscribeAudioCore, type NativeInsert } from './audioCore';
import { hidePluginEditor, showPluginEditor } from './pluginEditor';
import { getServices, subscribeServices } from './services';

export const BRIDGE_BLOCK = 256;

// The round trip's fixed delay. Long enough to ride out worker / socket
// hiccups; the engine delays every other track by the same amount.
export const bridgeLatencyFrames = (sampleRate: number) => Math.ceil((0.04 * sampleRate) / 128) * 128;

// A device GhostDAW hosts: by its plug-in's id (pluginId), or, from before
// ids, by a path the scanned list resolves to one
export const isNativeDevice = (device: any) => device?.type === 'vst'
  && ((typeof device.pluginId === 'string' && device.pluginId.length > 0) || (typeof device.pluginPath === 'string' && device.pluginPath.length > 0));

export interface NativeDeviceState {
  connected: boolean;
  insert: NativeInsert | null;  // the loaded plugin, its parameters and latency
  error: string | null;
  latencyFrames: number;        // bridge + plugin latency
  stats: { sent: number; returned: number; late: number; minSlack: number | null } | null;
}

const states = new Map<string, NativeDeviceState>();
const listeners = new Set<() => void>();
const latencyListeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeNativeDevices = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getNativeDeviceState = (deviceId: string) => states.get(deviceId) ?? null;
// Fires when any native device's latency changes (the engine re-compensates)
export const onNativeLatencyChange = (fn: () => void) => { latencyListeners.add(fn); return () => { latencyListeners.delete(fn); }; };

// The device's parameter values as last sent to (or reported by) its plug-in
const sentValues = new Map<string, Record<string, ParamValue>>();

// A parameter changed in the plug-in's own editor: the owner of the device
// (the store) keeps the new value. Its update comes back through the DSP's
// update() as the value already sent, so it isn't echoed to the plug-in.
// `gesture` marks a drag's start and release, when the plug-in reports them.
export interface EditorGesture { begin: boolean; end: boolean }
type EditorParameterListener = (deviceId: string, parameterId: string, value: number, gesture: EditorGesture | null) => void;
let editorParameterListener: EditorParameterListener | null = null;
export const onNativeEditorParameter = (fn: EditorParameterListener) => {
  editorParameterListener = fn;
  return () => { if (editorParameterListener === fn) editorParameterListener = null; };
};

// Opens the device's plug-in editor in the Audio Core; EDITOR_OPENED shows it
export const openNativeDeviceEditor = (deviceId: string) =>
  worker?.postMessage({ type: 'command', streamId: deviceId, message: { type: 'OPEN_EDITOR' } });

const updateState = (deviceId: string, patch: Partial<NativeDeviceState>) => {
  const prev = states.get(deviceId);
  if (!prev) return;
  const next = { ...prev, ...patch };
  states.set(deviceId, next);
  emit();
  if (next.latencyFrames !== prev.latencyFrames) latencyListeners.forEach((fn) => fn());
};

let worker: Worker | null = null;
const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL('./bridgeWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { type, streamId, connected, message } = e.data;
    const state = states.get(streamId);
    if (!state) return;
    if (type === 'status') {
      updateState(streamId, { connected, ...(connected ? {} : { error: null }) });
    } else if (message?.type === 'STREAM_STATE') {
      const insert: NativeInsert | null = message.insert || null;
      updateState(streamId, {
        insert, error: null,
        latencyFrames: (sampleRates.get(streamId) ? bridgeLatencyFrames(sampleRates.get(streamId)!) : 0) + (insert?.latencySamples || 0)
      });
    } else if (message?.type === 'PLUGIN_PARAMETER_CHANGED' && state.insert) {
      updateState(streamId, {
        insert: {
          ...state.insert,
          parameters: state.insert.parameters.map((p) => (p.index === message.parameterIndex ? { ...p, value: message.value, text: message.text } : p))
        }
      });
      const param = state.insert.parameters.find((p) => p.index === message.parameterIndex);
      if (message.source === 'editor' && param?.id && !param.readOnly) {
        sentValues.set(streamId, { ...(sentValues.get(streamId) || {}), [param.id]: message.value });
        worker?.postMessage({ type: 'remember', streamId, parameterId: param.id, value: message.value }); // for a reconnect's LOAD
        const gesture = message.gestureBegin || message.gestureEnd ? { begin: !!message.gestureBegin, end: !!message.gestureEnd } : null;
        editorParameterListener?.(streamId, param.id, message.value, gesture);
      }
    } else if (message?.type === 'EDITOR_OPENED') {
      showPluginEditor(message, () => worker?.postMessage({ type: 'command', streamId, message: { type: 'CLOSE_EDITOR' } }), state.connected);
    } else if (message?.type === 'EDITOR_CLOSED') {
      hidePluginEditor(message.editorId);
    } else if (message?.type === 'AUDIO_CORE_ERROR') {
      updateState(streamId, { error: message.message });
    }
  };
  return worker;
};

// Turning GhostDAW off stops every stream's connection and its retries;
// turning it on connects them again. The streams' address (GhostDAW's
// host, the stream port it announces and the pairing token) follows the
// service and the control connection: a change reconnects every stream.
let lastEnabled = getServices().ghostdaw.enabled;
let lastUrl: string | null = null;
const followStreams = () => {
  const enabled = getServices().ghostdaw.enabled;
  const url = nativeStreamUrl();
  if (enabled !== lastEnabled) {
    lastEnabled = enabled;
    lastUrl = url;
    worker?.postMessage({ type: enabled ? 'resume' : 'pause', url });
    return;
  }
  if (url === lastUrl) return;
  lastUrl = url;
  worker?.postMessage({ type: 'url', url });
};
subscribeServices(followStreams);
subscribeAudioCore(followStreams);

// Devices waiting for their plug-in's id (from before ids: a path the
// scanned list hasn't matched yet); the LOAD goes out once it has
const awaitingId = new Map<string, any>();
subscribeAudioCore(() => {
  awaitingId.forEach((device, streamId) => {
    const pluginId = nativePluginIdOf(device);
    if (!pluginId) return;
    awaitingId.delete(streamId);
    worker?.postMessage({ type: 'command', streamId, message: { type: 'LOAD', pluginId, parameters: sentValues.get(streamId) } });
  });
});

// A native device may load (or no longer may): the engine looks again
export const refreshNativeDevices = () => latencyListeners.forEach((fn) => fn());

const sampleRates = new Map<string, number>();

// The transport as the worklets need it (audio/transport.ts
// getTransportSnapshot): each one stamps its blocks with tempo and position.
// `source` gives the current one to a new worklet; `changed` sends every
// worklet the new one.
const nodes = new Map<string, AudioWorkletNode>();
let transportSource: (() => unknown) | null = null;
export function connectNativeTransport(source: () => unknown) {
  transportSource = source;
  return function changed() {
    const transport = source();
    nodes.forEach((node) => node.port.postMessage({ type: 'transport', transport }));
  };
}

// The device's DSP: the worklet node plus parameter sync. `update` sends the
// parameter values that changed since the last update.
export function createNativeInsertDSP(ctx: BaseAudioContext, device: any): DeviceDSP {
  const latency = bridgeLatencyFrames(ctx.sampleRate);
  // No outputChannelCount: the output keeps the input's channel count, so a
  // mono track stays mono (and its pan law, and so its level) through a
  // plug-in. The Audio Core always gets two channels.
  const node = new AudioWorkletNode(ctx, 'noprod-native-insert', {
    numberOfInputs: 1, numberOfOutputs: 1,
    processorOptions: { latency, block: BRIDGE_BLOCK }
  });
  const streamId: string = device.id;
  sampleRates.set(streamId, ctx.sampleRate);
  nodes.set(streamId, node);
  if (transportSource) node.port.postMessage({ type: 'transport', transport: transportSource() });
  states.set(streamId, { connected: false, insert: null, error: null, latencyFrames: latency, stats: null });
  emit();
  latencyListeners.forEach((fn) => fn());

  node.port.onmessage = (e) => {
    if (e.data?.type === 'stats') {
      const { sent, returned, late, minSlack } = e.data;
      updateState(streamId, { stats: { sent, returned, late, minSlack } });
    }
  };

  const link = new MessageChannel();
  node.port.postMessage({ type: 'link', port: link.port1 }, [link.port1]);
  const w = getWorker();
  lastUrl = nativeStreamUrl();
  w.postMessage({ type: 'open', streamId, url: lastUrl, sampleRate: ctx.sampleRate, block: BRIDGE_BLOCK, port: link.port2 }, [link.port2]);

  // The plug-in loads by its id only (GhostDAW refuses a path)
  sentValues.set(streamId, { ...(device.parameters || {}) });
  const pluginId = nativePluginIdOf(device);
  if (pluginId) w.postMessage({ type: 'command', streamId, message: { type: 'LOAD', pluginId, parameters: sentValues.get(streamId) } });
  else awaitingId.set(streamId, device);

  return {
    input: node,
    output: node,
    update(params) {
      const sent = sentValues.get(streamId) || {};
      // A value the device no longer holds (an undo back to before it was
      // set) means the plug-in's default
      const wanted: Record<string, ParamValue> = { ...params };
      Object.keys(sent).forEach((id) => {
        if (wanted[id] !== undefined) return;
        const p = states.get(streamId)?.insert?.parameters.find((q) => q.id === id);
        if (p && !p.readOnly) wanted[id] = p.default;
      });
      Object.entries(wanted).forEach(([id, value]) => {
        if (sent[id] === value || typeof value !== 'number') return;
        w.postMessage({ type: 'command', streamId, message: { type: 'SET_PARAM', parameterId: id, value } });
      });
      sentValues.set(streamId, wanted);
    },
    latencySeconds: () => (states.get(streamId)?.latencyFrames ?? latency) / ctx.sampleRate,
    dispose() {
      awaitingId.delete(streamId);
      w.postMessage({ type: 'close', streamId });
      node.port.onmessage = null;
      node.disconnect();
      states.delete(streamId);
      sampleRates.delete(streamId);
      sentValues.delete(streamId);
      nodes.delete(streamId);
      emit();
      latencyListeners.forEach((fn) => fn());
    }
  };
}
