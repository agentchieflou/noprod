// The browser audio engine: one mixer strip per track / return / master, each
//   input -> [device chain DSP] -> panner -> fader -> mute -> output target
// with post-fader sends from each track into every return strip. The graph is
// kept in sync with the store by syncEngine(), which only touches nodes whose
// backing state actually changed.

import { getAudioInputNode, isMonitoring, onInputsChange } from './inputs';
import { createDeviceDSP, deviceKind, resolvedParameters, loadDeviceWorklets, type DeviceDSP, type ParamTarget } from './devices';

export const audioContext: AudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

// Master bus tail: limiter (brickwall-configured compressor) -> analyser -> output.
// The analyser stays in the chain even when the limiter is bypassed so the
// meter always reflects what actually hits the speakers.
export const masterLimiter = audioContext.createDynamicsCompressor();
masterLimiter.threshold.value = -1;
masterLimiter.knee.value = 0;
masterLimiter.ratio.value = 20;
masterLimiter.attack.value = 0.001;
masterLimiter.release.value = 0.1;
export const masterAnalyser = audioContext.createAnalyser();
masterAnalyser.fftSize = 2048;
masterLimiter.connect(masterAnalyser);
masterAnalyser.connect(audioContext.destination);

export const MASTER_ID = 'master';

interface Strip {
  id: string;
  input: GainNode;
  panner: StereoPannerNode;
  fader: GainNode;              // volume (automatable)
  mute: GainNode;               // 0/1 for mute & solo, kept apart from volume automation
  sends: Map<string, GainNode>; // returnId -> send level (post-fader, post-mute)
  chainSig: string;
  chainOutputs: AudioNode[];    // outputs of the devices currently wired, for teardown
  outputTarget: string | null;
  monitorSource: AudioNode | null; // live audio input being monitored into this strip
}

const strips = new Map<string, Strip>();
const dsps = new Map<string, DeviceDSP>();
const lastDeviceState = new Map<string, any>(); // deviceId -> device object last applied

const createStrip = (id: string): Strip => {
  const input = audioContext.createGain();
  const panner = audioContext.createStereoPanner();
  const fader = audioContext.createGain();
  const mute = audioContext.createGain();
  panner.connect(fader);
  fader.connect(mute);
  // chainSig starts unmatched so the first wireChain always patches input -> panner
  const strip = { id, input, panner, fader, mute, sends: new Map(), chainSig: '<unwired>', chainOutputs: [], outputTarget: null, monitorSource: null };
  strips.set(id, strip);
  return strip;
};

const destroyStrip = (strip: Strip) => {
  if (strip.monitorSource) strip.monitorSource.disconnect(strip.input);
  strip.input.disconnect();
  strip.chainOutputs.forEach((n) => n.disconnect());
  strip.panner.disconnect();
  strip.fader.disconnect();
  strip.mute.disconnect();
  strip.sends.forEach((g) => g.disconnect());
  strips.delete(strip.id);
};

// Racks are serial containers in this DAW, so a rack contributes its inner
// devices to the chain in order.
export const flattenDevices = (plugins: any[] = []): any[] =>
  plugins.flatMap((p: any) => (p.type === 'rack' ? p.devices || [] : [p]));

const setParam = (p: AudioParam, v: number) => {
  if (Math.abs(p.value - v) > 1e-6) p.value = v;
};

// `skipUpdates`: devices whose params are being driven by automation right now
const wireChain = (strip: Strip, plugins: any[], skipUpdates?: Set<string>) => {
  const devices = flattenDevices(plugins);
  const sig = devices.map((d) => `${d.id}:${deviceKind(d) || 'thru'}`).join('|');

  devices.forEach((d) => {
    let dsp = dsps.get(d.id);
    if (!dsp && deviceKind(d)) {
      const created = createDeviceDSP(audioContext, d);
      if (created) { dsps.set(d.id, created); dsp = created; lastDeviceState.set(d.id, d); }
    } else if (dsp && lastDeviceState.get(d.id) !== d && !skipUpdates?.has(d.id)) {
      dsp.update(resolvedParameters(d));
      lastDeviceState.set(d.id, d);
    }
  });

  if (sig === strip.chainSig) return;
  strip.chainSig = sig;
  strip.input.disconnect();
  strip.chainOutputs.forEach((n) => n.disconnect());
  strip.chainOutputs = [];
  let prev: AudioNode = strip.input;
  devices.forEach((d) => {
    const dsp = dsps.get(d.id);
    if (!dsp) return; // pass-through device (unhosted VST)
    prev.connect(dsp.input);
    prev = dsp.output;
    strip.chainOutputs.push(dsp.output);
  });
  prev.connect(strip.panner);
};

// Patch a strip's output into its target plus all of its sends.
const routeStrip = (strip: Strip, targetId: string) => {
  if (strip.outputTarget === targetId) return;
  strip.mute.disconnect();
  if (targetId === 'destination') {
    strip.mute.connect(masterAnalyser);
  } else if (targetId === 'limiter') {
    strip.mute.connect(masterLimiter);
  } else {
    const target = strips.get(targetId);
    if (target) strip.mute.connect(target.input);
  }
  strip.sends.forEach((g) => strip.mute.connect(g));
  strip.outputTarget = targetId;
};

const sendLevel = (track: any, returnId: string) => track.sends?.[returnId] ?? 0;

let lastState: any = null;
let automationPlaying = false;

export function syncEngine(state: any) {
  if (lastState
    && lastState.tracks === state.tracks
    && lastState.returns === state.returns
    && lastState.masterPlugins === state.masterPlugins
    && lastState.masterVolume === state.masterVolume
    && lastState.masterPan === state.masterPan
    && lastState.isLimiterEnabled === state.isLimiterEnabled) return;
  lastState = state;

  const tracks: any[] = state.tracks || [];
  const returns: any[] = state.returns || [];
  const live = new Set<string>([MASTER_ID]);

  // Master
  const master = strips.get(MASTER_ID) || createStrip(MASTER_ID);
  wireChain(master, state.masterPlugins || []);
  setParam(master.panner.pan, state.masterPan || 0);
  setParam(master.fader.gain, state.masterVolume);
  routeStrip(master, state.isLimiterEnabled ? 'limiter' : 'destination');

  // Returns
  returns.forEach((r) => {
    live.add(r.id);
    const strip = strips.get(r.id) || createStrip(r.id);
    wireChain(strip, r.plugins || []);
    setParam(strip.panner.pan, r.pan || 0);
    setParam(strip.fader.gain, r.volume);
    setParam(strip.mute.gain, r.isMuted ? 0 : 1);
    routeStrip(strip, MASTER_ID);
  });

  // Tracks: solo silences every track that is neither soloed itself, inside a
  // soloed group, nor a group containing a soloed member.
  const soloed = new Set(tracks.filter((t) => t.isSoloed).map((t) => t.id));
  const audible = (t: any) => {
    if (t.isMuted) return false;
    if (soloed.size === 0 || soloed.has(t.id)) return true;
    if (t.groupId && soloed.has(t.groupId)) return true;
    return t.type === 'group' && tracks.some((m) => m.groupId === t.id && soloed.has(m.id));
  };

  tracks.forEach((t) => {
    live.add(t.id);
    const strip = strips.get(t.id) || createStrip(t.id);
    // While automation plays, an automated control's lane owns its AudioParam
    const auto = automationPlaying ? t.automation || {} : {};
    const automated = (key: string) => (auto[key]?.length || 0) > 0;
    const skipDevices = new Set(Object.keys(auto).filter(automated)
      .filter((k) => k.startsWith('device:')).map((k) => k.split(':')[1]));
    wireChain(strip, t.plugins || [], skipDevices);
    if (!automated('pan')) setParam(strip.panner.pan, t.pan || 0);
    if (!automated('volume')) setParam(strip.fader.gain, t.volume);
    setParam(strip.mute.gain, audible(t) ? 1 : 0);

    // Sends: one post-fader gain per return
    returns.forEach((r) => {
      let g = strip.sends.get(r.id);
      if (!g) {
        g = audioContext.createGain();
        g.gain.value = 0;
        strip.sends.set(r.id, g);
        strip.mute.connect(g);
        g.connect(strips.get(r.id)!.input);
      }
      if (!automated(`send:${r.id}`)) setParam(g.gain, sendLevel(t, r.id));
    });
    strip.sends.forEach((g, rid) => {
      if (!returns.some((r) => r.id === rid)) { g.disconnect(); strip.sends.delete(rid); }
    });
  });

  // Output routing (after every strip exists, so group/return targets
  // resolve): the track's chosen output, else its group, else the master.
  // A choice that would feed back into the track itself falls back to master.
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const outputOf = (t: any): string => {
    if (t.routing && t.routing !== 'master' && t.routing !== t.id && strips.has(t.routing)) return t.routing;
    if (t.groupId && strips.has(t.groupId)) return t.groupId;
    return MASTER_ID;
  };
  const feedsBack = (t: any) => {
    const seen = new Set<string>([t.id]);
    for (let id = outputOf(t); id !== MASTER_ID; ) {
      if (seen.has(id)) return true;
      seen.add(id);
      const next = trackById.get(id);
      if (!next) return false; // a return: returns always go to master
      id = outputOf(next);
    }
    return false;
  };
  tracks.forEach((t) => routeStrip(strips.get(t.id)!, feedsBack(t) ? MASTER_ID : outputOf(t)));

  // Input monitoring: an audio track's input feeds its strip while monitored
  tracks.forEach((t) => {
    const strip = strips.get(t.id)!;
    const inp = t.input || { type: 'ext', device: 'default', channel: '1/2' };
    const want = t.type === 'audio' && inp.type === 'ext' && isMonitoring(t)
      ? getAudioInputNode(inp.device || 'default', inp.channel || '1/2')
      : null;
    if (strip.monitorSource === want) return;
    if (strip.monitorSource) strip.monitorSource.disconnect(strip.input);
    if (want) want.connect(strip.input);
    strip.monitorSource = want;
  });

  // Tear down strips and devices that no longer exist
  strips.forEach((s, id) => { if (!live.has(id)) destroyStrip(s); });
  const liveDevices = new Set<string>();
  [state.masterPlugins || [], ...returns.map((r) => r.plugins || []), ...tracks.map((t) => t.plugins || [])]
    .forEach((pl) => flattenDevices(pl).forEach((d) => liveDevices.add(d.id)));
  dsps.forEach((dsp, id) => {
    if (!liveDevices.has(id)) { dsp.dispose(); dsps.delete(id); lastDeviceState.delete(id); }
  });
}

// ---------------------------------------------------------------- automation
// Lane keys: 'volume' | 'pan' | 'send:<returnId>' | 'device:<deviceId>:<param>'

export function getAutomationTargets(trackId: string, key: string): ParamTarget[] {
  const strip = strips.get(trackId);
  if (!strip) return [];
  if (key === 'volume') return [{ param: strip.fader.gain, map: (v) => v }];
  if (key === 'pan') return [{ param: strip.panner.pan, map: (v) => v }];
  if (key.startsWith('send:')) {
    const g = strip.sends.get(key.slice(5));
    return g ? [{ param: g.gain, map: (v) => v }] : [];
  }
  if (key.startsWith('device:')) {
    const [, deviceId, ...rest] = key.split(':');
    return dsps.get(deviceId)?.targets?.(rest.join(':')) || [];
  }
  return [];
}

// The transport toggles this around playback; when automation stops, every
// automated param drops its schedule and returns to its static (store) value.
export function setAutomationPlaying(on: boolean, state?: any) {
  automationPlaying = on;
  if (on || !state) return;
  (state.tracks || []).forEach((t: any) => {
    Object.keys(t.automation || {}).forEach((key) => {
      getAutomationTargets(t.id, key).forEach(({ param }) => param.cancelScheduledValues(0));
    });
  });
  lastState = null;
  lastDeviceState.clear();
  syncEngine(state);
}

// Where sources for a track (clips, notes, frozen audio) should connect.
export const getStripInput = (id: string): AudioNode => (strips.get(id) || strips.get(MASTER_ID))!.input;

export const getDeviceDSP = (deviceId: string): DeviceDSP | undefined => dsps.get(deviceId);

// Register worklet-based devices, then keep the graph in step with the store.
// Worklet failures are non-fatal: those devices fall back to pass-through.
export async function initEngine(store: { getState: () => any; subscribe: (fn: (s: any) => void) => unknown }) {
  try {
    await loadDeviceWorklets(audioContext);
  } catch (err) {
    console.warn('Audio worklets unavailable; dynamics devices will pass audio through', err);
  }
  syncEngine(store.getState());
  store.subscribe(syncEngine);
  // an input finishing opening (async permission) may complete a monitor connection
  onInputsChange(() => { lastState = null; syncEngine(store.getState()); });
}

export const resumeAudio = () => {
  if (audioContext.state === 'suspended') return audioContext.resume();
  return Promise.resolve();
};
