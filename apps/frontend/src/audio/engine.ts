// The browser audio engine: one mixer strip per track / return / master, each
//   input -> [device chain DSP] -> panner -> fader -> output target
// with post-fader sends from each track into every return strip. The graph is
// kept in sync with the store by syncEngine(), which only touches nodes whose
// backing state actually changed.

import { createDeviceDSP, deviceKind, resolvedParameters, type DeviceDSP } from './devices';

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
  fader: GainNode;
  sends: Map<string, GainNode>; // returnId -> send level
  chainSig: string;
  chainOutputs: AudioNode[];    // outputs of the devices currently wired, for teardown
  outputTarget: string | null;
}

const strips = new Map<string, Strip>();
const dsps = new Map<string, DeviceDSP>();
const lastDeviceState = new Map<string, any>(); // deviceId -> device object last applied

const createStrip = (id: string): Strip => {
  const input = audioContext.createGain();
  const panner = audioContext.createStereoPanner();
  const fader = audioContext.createGain();
  panner.connect(fader);
  // chainSig starts unmatched so the first wireChain always patches input -> panner
  const strip = { id, input, panner, fader, sends: new Map(), chainSig: '<unwired>', chainOutputs: [], outputTarget: null };
  strips.set(id, strip);
  return strip;
};

const destroyStrip = (strip: Strip) => {
  strip.input.disconnect();
  strip.chainOutputs.forEach((n) => n.disconnect());
  strip.panner.disconnect();
  strip.fader.disconnect();
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

const wireChain = (strip: Strip, plugins: any[]) => {
  const devices = flattenDevices(plugins);
  const sig = devices.map((d) => `${d.id}:${deviceKind(d) || 'thru'}`).join('|');

  devices.forEach((d) => {
    let dsp = dsps.get(d.id);
    if (!dsp && deviceKind(d)) {
      const created = createDeviceDSP(audioContext, d);
      if (created) { dsps.set(d.id, created); dsp = created; lastDeviceState.set(d.id, d); }
    } else if (dsp && lastDeviceState.get(d.id) !== d) {
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

// Patch a strip's fader into its output target plus all of its sends.
const routeStrip = (strip: Strip, targetId: string) => {
  if (strip.outputTarget === targetId) return;
  strip.fader.disconnect();
  if (targetId === 'destination') {
    strip.fader.connect(masterAnalyser);
  } else if (targetId === 'limiter') {
    strip.fader.connect(masterLimiter);
  } else {
    const target = strips.get(targetId);
    if (target) strip.fader.connect(target.input);
  }
  strip.sends.forEach((g) => strip.fader.connect(g));
  strip.outputTarget = targetId;
};

// Foundation return bus: one reverb return until the store models returns.
const DEFAULT_RETURN_REVERB = { id: 'return-a-reverb', name: 'NoProd Reverb', type: 'audio-fx', kind: 'reverb', parameters: { 'Dry/Wet': 100, Decay: 2.5 } };
let fallbackReturns: any[] = [];
let fallbackReturnVolume = -1;
const returnsOf = (state: any): any[] => {
  if (state.returns) return state.returns;
  if (state.reverbReturnVolume !== fallbackReturnVolume) {
    fallbackReturnVolume = state.reverbReturnVolume;
    fallbackReturns = [{ id: 'return-a', name: 'A-Reverb', volume: state.reverbReturnVolume, pan: 0, isMuted: false, plugins: [DEFAULT_RETURN_REVERB] }];
  }
  return fallbackReturns;
};
const sendLevel = (track: any, returnId: string) =>
  track.sends?.[returnId] ?? (returnId === 'return-a' ? track.sendReverb || 0 : 0);

let lastState: any = null;

export function syncEngine(state: any) {
  if (lastState
    && lastState.tracks === state.tracks
    && lastState.returns === state.returns
    && lastState.reverbReturnVolume === state.reverbReturnVolume
    && lastState.masterPlugins === state.masterPlugins
    && lastState.masterVolume === state.masterVolume
    && lastState.masterPan === state.masterPan
    && lastState.isLimiterEnabled === state.isLimiterEnabled) return;
  lastState = state;

  const tracks: any[] = state.tracks || [];
  const returns = returnsOf(state);
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
    setParam(strip.fader.gain, r.isMuted ? 0 : r.volume);
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
    wireChain(strip, t.plugins || []);
    setParam(strip.panner.pan, t.pan || 0);
    setParam(strip.fader.gain, audible(t) ? t.volume : 0);

    // Sends: one post-fader gain per return
    returns.forEach((r) => {
      let g = strip.sends.get(r.id);
      if (!g) {
        g = audioContext.createGain();
        g.gain.value = 0;
        strip.sends.set(r.id, g);
        strip.fader.connect(g);
        g.connect(strips.get(r.id)!.input);
      }
      setParam(g.gain, sendLevel(t, r.id));
    });
    strip.sends.forEach((g, rid) => {
      if (!returns.some((r) => r.id === rid)) { g.disconnect(); strip.sends.delete(rid); }
    });
  });

  // Output routing (after every strip exists, so group/return targets resolve)
  tracks.forEach((t) => {
    const strip = strips.get(t.id)!;
    let target = MASTER_ID;
    if (t.groupId && strips.has(t.groupId)) target = t.groupId;
    else if (t.routing && t.routing !== t.id && strips.has(t.routing)) target = t.routing;
    routeStrip(strip, target);
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

// Where sources for a track (clips, notes, frozen audio) should connect.
export const getStripInput = (id: string): AudioNode => (strips.get(id) || strips.get(MASTER_ID))!.input;

export const getDeviceDSP = (deviceId: string): DeviceDSP | undefined => dsps.get(deviceId);

export const resumeAudio = () => {
  if (audioContext.state === 'suspended') return audioContext.resume();
  return Promise.resolve();
};
