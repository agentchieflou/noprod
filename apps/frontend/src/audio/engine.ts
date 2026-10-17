// The browser audio engine: the app's context, the live mixer on it (one
// strip per track / return / master, with devices, sends, returns and the
// master's limiter: mixer.ts), its meters, and the context's state. The
// graph is kept in sync with the store by syncEngine().

import { getAudioInputNode, isMonitoring, onInputsChange } from './inputs';
import { loadDeviceWorklets, type DeviceDSP, type ParamTarget } from './devices';
import { onNativeLatencyChange } from '../native/trackBridge';
import type { LoudnessReadings } from './meterWorker';
import meterProcessorUrl from './worklets/meter-processor.js?url';
import { Mixer, MASTER_ID, flattenDevices, loadMixer, type MeterTap } from './mixer';

export { MASTER_ID, flattenDevices, type MeterTap };

// Why audio can't run, or null. When the browser refuses a real context (no
// device, a hardened browser) the app still loads on an offline one, which
// makes no sound, and says so (see AudioStatus).
export let audioError: string | null = null;
const createContext = (): AudioContext => {
  try {
    return new (window.AudioContext || (window as any).webkitAudioContext)();
  } catch (err) {
    audioError = `Audio is unavailable: ${err instanceof Error ? err.message : err}. Check that an output device is connected and that this browser allows audio.`;
    console.error('AudioContext failed', err);
    return new OfflineAudioContext(2, 1, 44100) as unknown as AudioContext;
  }
};
export const audioContext: AudioContext = createContext();

// The live mixer, with meters, and input monitoring on audio tracks
const live = new Mixer(audioContext, {
  meters: true,
  monitorSource: (t) => {
    const inp = t.input || { type: 'ext', device: 'default', channel: '1/2' };
    return t.type === 'audio' && inp.type === 'ext' && isMonitoring(t) ? getAudioInputNode(inp.device || 'default', inp.channel || '1/2') : null;
  }
});
export const liveMixer = () => live;
export const masterLimiter = live.masterLimiter;
export const masterAnalyser = live.out as AnalyserNode;

// Master loudness (BS.1770-4) over the same signal. A worklet streams the
// samples to a worker, which measures them and reports about ten times a second.
let loudnessWorker: Worker | null = null;
let loudnessReadings: LoudnessReadings = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeak: -Infinity };
export const getLoudness = () => loudnessReadings;
export const resetLoudness = () => loudnessWorker?.postMessage({ type: 'reset' });

// The engine worklet (engineNode.ts) feeds strips by id: it hears when a
// strip's input node comes or goes, to connect its output there
export const onStripInputChange = (fn: (id: string, input: AudioNode | null) => void) => live.onStripInputChange(fn);
// Which strip a node is the input of (what a note's destination names)
export const stripIdOf = (node: AudioNode): string | null => live.stripIdOf(node);
// An input that isn't a strip's but plays through the engine too (the Browser's previews)
export const registerInput = (id: string, node: AudioNode) => live.registerInput(id, node);
export const inputOf = (id: string): AudioNode => live.inputOf(id);

export const syncEngine = (state: any) => live.sync(state);

// How late the mix reaches the speakers because of latent devices (the
// slowest track path plus the master's own devices). The metronome is
// delayed and recordings are shifted by this much.
export const getCompensationSeconds = () => live.getCompensationSeconds();
export const onCompensationChange = (fn: () => void) => live.onCompensationChange(fn);

// Lane keys: 'volume' | 'pan' | 'send:<returnId>' | 'device:<deviceId>:<param>'
export const getAutomationTargets = (trackId: string, key: string): ParamTarget[] => live.getAutomationTargets(trackId, key);

// The transport toggles this around playback; when automation stops, every
// automated param drops its schedule and returns to its static (store) value.
export const setAutomationPlaying = (on: boolean, state?: any) => live.setAutomationPlaying(on, state);

// Where sources for a track (clips, notes, frozen audio) should connect.
export const getStripInput = (id: string): AudioNode => live.getStripInput(id);

// The meter for a track / return, or for the master (after the limiter)
export const getMeterTap = (id: string): MeterTap | undefined => live.getMeterTap(id);

export const getDeviceDSP = (deviceId: string): DeviceDSP | undefined => live.getDeviceDSP(deviceId);

// Register worklet-based devices, then keep the graph in step with the store.
// Worklet failures are non-fatal: those devices fall back to pass-through.
export async function initEngine(store: { getState: () => any; subscribe: (fn: (s: any) => void) => unknown }) {
  try {
    await Promise.all([loadDeviceWorklets(audioContext), loadMixer(audioContext)]);
  } catch (err) {
    console.warn('Audio worklets unavailable; dynamics devices will pass audio through', err);
  }
  try {
    await audioContext.audioWorklet.addModule(meterProcessorUrl);
    const node = new AudioWorkletNode(audioContext, 'noprod-meter', { numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const worker = new Worker(new URL('./meterWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<LoudnessReadings>) => { loudnessReadings = e.data; };
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ sampleRate: audioContext.sampleRate, port: port2 }, [port2]);
    node.port.postMessage({ port: port1 }, [port1]);
    loudnessWorker = worker;
    masterAnalyser.connect(node);
  } catch (err) {
    console.warn('Loudness meter unavailable', err);
  }
  syncEngine(store.getState());
  store.subscribe(syncEngine);
  // an input finishing opening (async permission) may complete a monitor connection
  onInputsChange(() => { live.invalidate(); syncEngine(store.getState()); });
  // a native plugin loading (or going away) changes how much to compensate;
  // resync once, after whatever (possibly a sync in progress) reported it
  let resyncQueued = false;
  onNativeLatencyChange(() => {
    if (resyncQueued) return;
    resyncQueued = true;
    queueMicrotask(() => { resyncQueued = false; live.invalidate(); syncEngine(store.getState()); });
  });
}

// 'interrupted' is iOS's state after a call or the screen locking
export const audioNeedsStart = () => !audioError && (audioContext.state as string) !== 'running' && audioContext.state !== 'closed';

// Resumes the context (from a user gesture, or when MIDI arrives). Never rejects.
export const resumeAudio = (): Promise<void> => {
  if (!audioNeedsStart()) return Promise.resolve();
  return audioContext.resume().catch((err) => console.warn('Audio could not start', err));
};

export const onAudioStateChange = (fn: () => void) => {
  audioContext.addEventListener('statechange', fn);
  return () => audioContext.removeEventListener('statechange', fn);
};

// iOS Safari 'interrupts' the context (a call, the screen locking) and only
// a user gesture starts it again
['pointerdown', 'keydown', 'touchend'].forEach((type) =>
  window.addEventListener(type, () => { if (audioContext.state !== 'running') audioContext.resume().catch(() => {}); }, { capture: true, passive: true }));
