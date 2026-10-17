// The mixer: one strip per track / return / master on a context, each
//   input -> [device chain DSP] -> latency compensation -> panner -> fader -> mute -> output target
// with post-fader sends from each track into every return strip, and the
// master's limiter at the end. kept in sync with the store by sync(), which
// only touches nodes whose backing state actually changed.
//
// The live mixer (engine.ts) is one instance on the app's context, with
// meters and input monitoring; an offline render (render.ts) builds another
// on an OfflineAudioContext from the same state, so a render goes through
// the same graph as playback.
//
// Latency compensation: devices that delay audio (native plugins hosted by
// the Audio Core, see native/trackBridge.ts) report their latency, and every
// other track is delayed to match the slowest path to the master, so the mix
// stays in time. The metronome and recording are offset by the same amount.

import { createDeviceDSP, dspKind, resolvedParameters, type DeviceDSP, type ParamTarget } from './devices';
import sumProcessorUrl from './worklets/sum-processor.js?url';

export const MASTER_ID = 'master';

const MAX_COMPENSATION = 2; // seconds of latency compensation a strip can apply
const SUM_INPUTS = 64;      // a strip's input: 0 for its sources, the rest one per strip or send feeding it

const summing = new WeakSet<BaseAudioContext>();
// Registers the summing worklet on a context, once. Until it is, strips
// made on that context sum natively (and a render on it isn't exact).
export async function loadMixer(ctx: BaseAudioContext) {
  if (summing.has(ctx)) return;
  await ctx.audioWorklet.addModule(sumProcessorUrl);
  summing.add(ctx);
}

// Level meters: each strip is tapped post-fader and post-mute by a pair of
// analysers (left, right). The master's pair sits after the limiter, so it
// shows what reaches the speakers.
export interface MeterTap { source: AudioNode; split: ChannelSplitterNode; left: AnalyserNode; right: AnalyserNode }

interface Strip {
  id: string;
  input: AudioNode;             // a summing worklet (sum-processor.js), or a gain before it is registered
  feeds: Map<AudioNode, number>; // what is routed into the input, by the input it has
  compensation: DelayNode;      // latency compensation, after the devices
  panner: StereoPannerNode;
  fader: GainNode;              // volume (automatable)
  mute: GainNode;               // 0/1 for mute & solo, kept apart from volume automation
  sends: Map<string, GainNode>; // returnId -> send level (post-fader, post-mute)
  chainSig: string;
  chainOutputs: AudioNode[];    // outputs of the devices currently wired, for teardown
  outputTarget: string | null;
  monitorSource: AudioNode | null; // live audio input being monitored into this strip
  meter: MeterTap | null;
}

export interface MixerOptions {
  meters?: boolean;                                   // analyser taps per strip (the live mixer)
  monitorSource?: (track: any) => AudioNode | null;   // live input monitoring, the live mixer's
  createDevice?: (ctx: BaseAudioContext, device: any) => DeviceDSP | null; // default: createDeviceDSP
  output?: AudioNode;                                 // where the master goes (the context's destination)
}

// Racks are serial containers in this DAW, so a rack contributes its inner
// devices to the chain in order.
export const flattenDevices = (plugins: any[] = []): any[] =>
  plugins.flatMap((p: any) => (p.type === 'rack' ? p.devices || [] : [p]));

const setParam = (p: AudioParam, v: number) => {
  if (Math.abs(p.value - v) > 1e-6) p.value = v;
};

const sendLevel = (track: any, returnId: string) => track.sends?.[returnId] ?? 0;

export class Mixer {
  readonly ctx: BaseAudioContext;
  // Master bus tail: limiter (brickwall-configured compressor) -> out -> output.
  // `out` stays in the chain even when the limiter is bypassed, so the live
  // mixer's meter (an analyser there) always reflects what hits the speakers.
  readonly masterLimiter: DynamicsCompressorNode;
  readonly out: AudioNode;
  readonly masterTap: MeterTap | null;

  private opts: MixerOptions;
  private strips = new Map<string, Strip>();
  private inputStrips = new WeakMap<AudioNode, string>(); // a strip's input node -> its id
  private extraInputs = new Map<string, AudioNode>();     // inputs that aren't strips' (the previews)
  private dsps = new Map<string, DeviceDSP>();
  private lastDeviceState = new Map<string, any>();       // deviceId -> device object last applied
  private stripListeners = new Set<(id: string, input: AudioNode | null) => void>();
  private lastState: any = null;
  private automationPlaying = false;
  private compensationSeconds = 0;
  private compensationListeners = new Set<() => void>();

  constructor(ctx: BaseAudioContext, opts: MixerOptions = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.1;
    if (opts.meters) {
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      this.out = an;
    } else {
      this.out = ctx.createGain();
    }
    this.masterLimiter.connect(this.out);
    this.out.connect(opts.output ?? ctx.destination);
    this.masterTap = opts.meters ? this.createMeterTap(this.out) : null;
  }

  // ------------------------------------------------------------------ strips

  private createMeterTap(source: AudioNode): MeterTap {
    const split = this.ctx.createChannelSplitter(2);
    const left = this.ctx.createAnalyser();
    const right = this.ctx.createAnalyser();
    left.fftSize = right.fftSize = 2048;
    left.smoothingTimeConstant = right.smoothingTimeConstant = 0;
    source.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    return { source, split, left, right };
  }

  private createStrip(id: string): Strip {
    const ctx = this.ctx;
    const input: AudioNode = summing.has(ctx)
      ? new AudioWorkletNode(ctx, 'noprod-sum', { numberOfInputs: SUM_INPUTS, numberOfOutputs: 1, outputChannelCount: [2] })
      : ctx.createGain();
    const compensation = ctx.createDelay(MAX_COMPENSATION);
    const panner = ctx.createStereoPanner();
    const fader = ctx.createGain();
    const mute = ctx.createGain();
    compensation.connect(panner);
    panner.connect(fader);
    fader.connect(mute);
    // chainSig starts unmatched so the first wireChain always patches input -> compensation
    const meter = this.opts.meters ? this.createMeterTap(mute) : null;
    const strip: Strip = { id, input, feeds: new Map(), compensation, panner, fader, mute, sends: new Map(), chainSig: '<unwired>', chainOutputs: [], outputTarget: null, monitorSource: null, meter };
    this.strips.set(id, strip);
    this.inputStrips.set(input, id);
    this.stripListeners.forEach((fn) => fn(id, input));
    return strip;
  }

  // A strip or a send feeding `strip`: on an input of its own, so the sum
  // is in a fixed order (what a native fan-in can't promise)
  private feed(source: AudioNode, strip: Strip) {
    if (strip.feeds.has(source)) return;
    const used = new Set(strip.feeds.values());
    let index = 1;
    while (used.has(index) && index < SUM_INPUTS) index++;
    if (index >= SUM_INPUTS || !(strip.input instanceof AudioWorkletNode)) index = 0; // full, or no worklet yet: sum natively
    strip.feeds.set(source, index);
    source.connect(strip.input, 0, index);
  }

  private unfeed(source: AudioNode, strip: Strip) {
    const index = strip.feeds.get(source);
    if (index === undefined) return;
    strip.feeds.delete(source);
    try { source.disconnect(strip.input, 0, index); } catch { /* already gone */ }
  }

  private destroyStrip(strip: Strip) {
    if (strip.monitorSource) strip.monitorSource.disconnect(strip.input);
    for (const target of this.strips.values()) this.unfeed(strip.mute, target);
    strip.input.disconnect();
    strip.chainOutputs.forEach((n) => n.disconnect());
    strip.compensation.disconnect();
    strip.panner.disconnect();
    strip.fader.disconnect();
    strip.mute.disconnect();
    strip.sends.forEach((g) => g.disconnect());
    strip.meter?.split.disconnect();
    this.strips.delete(strip.id);
    this.stripListeners.forEach((fn) => fn(strip.id, null));
  }

  // The engine worklet (engineNode.ts) feeds strips by id: it hears when a
  // strip's input node comes or goes, to connect its output there
  onStripInputChange(fn: (id: string, input: AudioNode | null) => void) {
    this.stripListeners.add(fn);
    return () => { this.stripListeners.delete(fn); };
  }

  // Which strip a node is the input of (what a note's destination names)
  stripIdOf(node: AudioNode): string | null { return this.inputStrips.get(node) ?? null; }

  // An input that isn't a strip's but plays through the engine too (the Browser's previews)
  registerInput(id: string, node: AudioNode) {
    this.extraInputs.set(id, node);
    this.inputStrips.set(node, id);
  }

  // Where sources for a track (clips, notes, frozen audio) should connect.
  getStripInput(id: string): AudioNode { return (this.strips.get(id) || this.strips.get(MASTER_ID))!.input; }
  inputOf(id: string): AudioNode { return this.extraInputs.get(id) ?? this.getStripInput(id); }
  hasStrip(id: string) { return this.strips.has(id); }

  // A strip's output as it leaves it: post-fader, post-mute, before its
  // sends and its route (what a stem is)
  stripOutput(id: string): AudioNode | null { return this.strips.get(id)?.mute ?? null; }

  // The meter for a track / return, or for the master (after the limiter)
  getMeterTap(id: string): MeterTap | undefined { return (id === MASTER_ID ? this.masterTap : this.strips.get(id)?.meter) ?? undefined; }

  getDeviceDSP(deviceId: string): DeviceDSP | undefined { return this.dsps.get(deviceId); }

  // ----------------------------------------------------------------- wiring

  // `skipUpdates`: devices whose params are being driven by automation right now
  private wireChain(strip: Strip, plugins: any[], skipUpdates?: Set<string>) {
    const devices = flattenDevices(plugins);
    const sig = devices.map((d) => `${d.id}:${dspKind(d) || 'thru'}`).join('|');

    devices.forEach((d) => {
      let dsp = this.dsps.get(d.id);
      if (!dsp && dspKind(d)) {
        const created = (this.opts.createDevice ?? createDeviceDSP)(this.ctx, d);
        if (created) { this.dsps.set(d.id, created); dsp = created; this.lastDeviceState.set(d.id, d); }
      } else if (dsp && this.lastDeviceState.get(d.id) !== d && !skipUpdates?.has(d.id)) {
        dsp.update(resolvedParameters(d));
        this.lastDeviceState.set(d.id, d);
      }
    });

    if (sig === strip.chainSig) return;
    strip.chainSig = sig;
    strip.input.disconnect();
    strip.chainOutputs.forEach((n) => n.disconnect());
    strip.chainOutputs = [];
    let prev: AudioNode = strip.input;
    devices.forEach((d) => {
      const dsp = this.dsps.get(d.id);
      if (!dsp) return; // pass-through device (unlinked VST)
      prev.connect(dsp.input);
      prev = dsp.output;
      strip.chainOutputs.push(dsp.output);
    });
    prev.connect(strip.compensation);
  }

  // Patch a strip's output into its target plus all of its sends.
  private routeStrip(strip: Strip, targetId: string) {
    if (strip.outputTarget === targetId) return;
    if (strip.outputTarget !== null) { const prev = this.strips.get(strip.outputTarget); if (prev) this.unfeed(strip.mute, prev); }
    strip.mute.disconnect();
    if (strip.meter) strip.mute.connect(strip.meter.split); // disconnect() above drops the meter tap too
    if (targetId === 'destination') {
      strip.mute.connect(this.out);
    } else if (targetId === 'limiter') {
      strip.mute.connect(this.masterLimiter);
    } else {
      const target = this.strips.get(targetId);
      if (target) { target.feeds.delete(strip.mute); this.feed(strip.mute, target); }
    }
    strip.sends.forEach((g) => strip.mute.connect(g));
    strip.outputTarget = targetId;
  }

  // ------------------------------------------------------------------- sync

  // Forget what was applied, so the next sync applies everything
  invalidate() { this.lastState = null; }

  sync(state: any) {
    const lastState = this.lastState;
    if (lastState
      && lastState.tracks === state.tracks
      && lastState.returns === state.returns
      && lastState.masterPlugins === state.masterPlugins
      && lastState.masterVolume === state.masterVolume
      && lastState.masterPan === state.masterPan
      && lastState.isLimiterEnabled === state.isLimiterEnabled) return;
    this.lastState = state;
    const strips = this.strips;

    const tracks: any[] = state.tracks || [];
    const returns: any[] = state.returns || [];
    const live = new Set<string>([MASTER_ID]);

    // Master
    const master = strips.get(MASTER_ID) || this.createStrip(MASTER_ID);
    this.wireChain(master, state.masterPlugins || []);
    setParam(master.panner.pan, state.masterPan || 0);
    setParam(master.fader.gain, state.masterVolume);
    this.routeStrip(master, state.isLimiterEnabled ? 'limiter' : 'destination');

    // Returns
    returns.forEach((r) => {
      live.add(r.id);
      const strip = strips.get(r.id) || this.createStrip(r.id);
      this.wireChain(strip, r.plugins || []);
      setParam(strip.panner.pan, r.pan || 0);
      setParam(strip.fader.gain, r.volume);
      setParam(strip.mute.gain, r.isMuted ? 0 : 1);
      this.routeStrip(strip, MASTER_ID);
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
      const strip = strips.get(t.id) || this.createStrip(t.id);
      // While automation plays, an automated control's lane owns its AudioParam
      const auto = this.automationPlaying ? t.automation || {} : {};
      const automated = (key: string) => (auto[key]?.length || 0) > 0;
      const skipDevices = new Set(Object.keys(auto).filter(automated)
        .filter((k) => k.startsWith('device:')).map((k) => k.split(':')[1]));
      this.wireChain(strip, t.plugins || [], skipDevices);
      if (!automated('pan')) setParam(strip.panner.pan, t.pan || 0);
      if (!automated('volume')) setParam(strip.fader.gain, t.volume);
      setParam(strip.mute.gain, audible(t) ? 1 : 0);

      // Sends: one post-fader gain per return
      returns.forEach((r) => {
        let g = strip.sends.get(r.id);
        if (!g) {
          g = this.ctx.createGain();
          g.gain.value = 0;
          strip.sends.set(r.id, g);
          strip.mute.connect(g);
          this.feed(g, strips.get(r.id)!);
        }
        if (!automated(`send:${r.id}`)) setParam(g.gain, sendLevel(t, r.id));
      });
      strip.sends.forEach((g, rid) => {
        if (!returns.some((r) => r.id === rid)) { const ret = strips.get(rid); if (ret) this.unfeed(g, ret); g.disconnect(); strip.sends.delete(rid); }
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
    tracks.forEach((t) => this.routeStrip(strips.get(t.id)!, feedsBack(t) ? MASTER_ID : outputOf(t)));
    this.compensateLatency(tracks, (t) => (feedsBack(t) ? MASTER_ID : outputOf(t)), state.masterPlugins || []);

    // Input monitoring: an audio track's input feeds its strip while monitored
    tracks.forEach((t) => {
      const strip = strips.get(t.id)!;
      const want = this.opts.monitorSource?.(t) ?? null;
      if (strip.monitorSource === want) return;
      if (strip.monitorSource) strip.monitorSource.disconnect(strip.input);
      if (want) want.connect(strip.input);
      strip.monitorSource = want;
    });

    // Tear down strips and devices that no longer exist
    strips.forEach((s, id) => { if (!live.has(id)) this.destroyStrip(s); });
    const liveDevices = new Set<string>();
    [state.masterPlugins || [], ...returns.map((r) => r.plugins || []), ...tracks.map((t) => t.plugins || [])]
      .forEach((pl) => flattenDevices(pl).forEach((d) => liveDevices.add(d.id)));
    this.dsps.forEach((dsp, id) => {
      if (!liveDevices.has(id)) { dsp.dispose(); this.dsps.delete(id); this.lastDeviceState.delete(id); }
    });
  }

  // ------------------------------------------------------ latency compensation

  private deviceLatency(plugins: any[]) {
    return flattenDevices(plugins).reduce((sum, d) => sum + (this.dsps.get(d.id)?.latencySeconds?.() ?? 0), 0);
  }

  // How late the mix reaches the speakers because of latent devices (the
  // slowest track path plus the master's own devices). The metronome is
  // delayed and recordings are shifted by this much.
  getCompensationSeconds() { return this.compensationSeconds; }
  onCompensationChange(fn: () => void) { this.compensationListeners.add(fn); return () => { this.compensationListeners.delete(fn); }; }

  // Delay each track that nothing else feeds (clips play there) so every path
  // to the master is as late as the slowest one. A track's path latency is its
  // own devices plus those of the groups / tracks it is routed through. Tracks
  // that receive other tracks (groups) aren't delayed themselves: their inputs
  // already are.
  private compensateLatency(tracks: any[], routedTo: (t: any) => string, masterPlugins: any[]) {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const own = new Map(tracks.map((t) => [t.id, this.deviceLatency(t.plugins || [])]));
    const fed = new Set(tracks.map(routedTo).filter((id) => id !== MASTER_ID));

    const pathLatency = (t: any) => {
      let total = own.get(t.id) || 0;
      const seen = new Set([t.id]);
      for (let id = routedTo(t); id !== MASTER_ID && byId.has(id) && !seen.has(id); id = routedTo(byId.get(id))) {
        seen.add(id);
        total += own.get(id) || 0;
      }
      return total;
    };

    const sources = tracks.filter((t) => !fed.has(t.id));
    const paths = new Map(sources.map((t) => [t.id, pathLatency(t)]));
    const slowest = Math.min(MAX_COMPENSATION, Math.max(0, ...paths.values()));

    tracks.forEach((t) => {
      const strip = this.strips.get(t.id);
      if (strip) setParam(strip.compensation.delayTime, fed.has(t.id) ? 0 : Math.max(0, slowest - (paths.get(t.id) || 0)));
    });

    const total = slowest + this.deviceLatency(masterPlugins);
    if (Math.abs(total - this.compensationSeconds) > 1e-6) {
      this.compensationSeconds = total;
      this.compensationListeners.forEach((fn) => fn());
    }
  }

  // ---------------------------------------------------------------- automation
  // Lane keys: 'volume' | 'pan' | 'send:<returnId>' | 'device:<deviceId>:<param>'

  getAutomationTargets(trackId: string, key: string): ParamTarget[] {
    const strip = this.strips.get(trackId);
    if (!strip) return [];
    if (key === 'volume') return [{ param: strip.fader.gain, map: (v) => v }];
    if (key === 'pan') return [{ param: strip.panner.pan, map: (v) => v }];
    if (key.startsWith('send:')) {
      const g = strip.sends.get(key.slice(5));
      return g ? [{ param: g.gain, map: (v) => v }] : [];
    }
    if (key.startsWith('device:')) {
      const [, deviceId, ...rest] = key.split(':');
      return this.dsps.get(deviceId)?.targets?.(rest.join(':')) || [];
    }
    return [];
  }

  // The transport toggles this around playback; when automation stops, every
  // automated param drops its schedule and returns to its static (store) value.
  setAutomationPlaying(on: boolean, state?: any) {
    this.automationPlaying = on;
    if (on || !state) return;
    (state.tracks || []).forEach((t: any) => {
      Object.keys(t.automation || {}).forEach((key) => {
        this.getAutomationTargets(t.id, key).forEach(({ param }) => param.cancelScheduledValues(0));
      });
    });
    this.lastState = null;
    this.lastDeviceState.clear();
    this.sync(state);
  }

  dispose() {
    this.strips.forEach((s) => this.destroyStrip(s));
    this.dsps.forEach((d) => d.dispose());
    this.dsps.clear();
    this.masterLimiter.disconnect();
    this.out.disconnect();
  }
}
