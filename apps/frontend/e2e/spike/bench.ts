// The engine spike for #159: the same project built three ways, measured.
//
//   a   the Web Audio graph we have: a node per note, native devices
//       (EQ Eight = 32 biquads, the dynamics worklet, a 2.5 s convolver),
//       notes scheduled from the main thread a window ahead
//   b   one AudioWorklet running every device in TypeScript (engine-processor)
//   c   a hybrid: sources in a per-track worklet (player-processor), the
//       native devices and mixer of (a)
//
// `-fdn` swaps the convolver for the FDN reverb worklet, so (a) and (b)
// differ only in who runs the DSP. `-nodev` has no devices at all.
//
// Project: `tracks` MIDI tracks, each a library instrument playing eighth
// notes at 120 BPM (4 notes a second), 3 devices each.

import { render, findSound, type SoundRecipe } from '../../../../packages/sound/src/index.ts';
import { DEVICE_DEFS, loadDeviceWorklets, type DeviceDSP } from '../../src/audio/devices.ts';
import playerUrl from './player-processor.ts?worker&url';
import engineUrl from './engine-processor.ts?worker&url';
import fdnUrl from './fdn-processor.ts?worker&url';
import probeUrl from './probe-processor.js?url';

const BPM = 120;
const NOTES_PER_BEAT = 2;
const GATE = 0.2;
const SOUND_IDS = ['piano-electric', 'marimba', 'bass-finger', 'pad-warm'];
const SCALE = [0, 2, 4, 7, 9, 12, 9, 7];
const VELOCITY = 0.8;

type Variant = 'a' | 'a-fdn' | 'a-nodev' | 'b' | 'b-nodev' | 'c' | 'c-fdn' | 'c-nodev';

interface Rendered { id: number; l: Float32Array; r: Float32Array }
let rendered: Rendered[] = [];     // sound s, degree d -> id s * 8 + d
const bufferId = (track: number, step: number) => (track % SOUND_IDS.length) * 8 + (step % 8);

// Render the 32 note buffers the project needs (4 sounds, 8 degrees)
export function prepare(sampleRate: number) {
  const t0 = performance.now();
  rendered = [];
  SOUND_IDS.forEach((id, s) => {
    const sound = findSound(id) as SoundRecipe;
    SCALE.forEach((degree, d) => {
      const note = 48 + s * 5 + degree;
      const r = render(sound, { note, velocity: VELOCITY, gate: GATE, sampleRate });
      rendered.push({ id: s * 8 + d, l: r.left, r: r.right });
    });
  });
  const seconds = rendered.reduce((n, b) => n + b.l.length, 0) / sampleRate;
  return { buffers: rendered.length, totalSeconds: seconds, ms: performance.now() - t0 };
}

// Every note of `track` in [from, to) seconds of the song
function notesOf(track: number, from: number, to: number) {
  const step = 60 / BPM / NOTES_PER_BEAT;
  const out: { at: number; buf: number }[] = [];
  for (let i = Math.ceil(from / step - 1e-9); i * step < to; i++) {
    out.push({ at: i * step, buf: bufferId(track, i + track) });
  }
  return out;
}

// ------------------------------------------------------------------ graphs

const audioBuffers = new WeakMap<BaseAudioContext, AudioBuffer[]>();
const bufferFor = (ctx: BaseAudioContext, id: number) => {
  let list = audioBuffers.get(ctx);
  if (!list) {
    list = rendered.map((b) => {
      const buf = ctx.createBuffer(2, b.l.length, ctx.sampleRate);
      buf.copyToChannel(b.l, 0); buf.copyToChannel(b.r, 1);
      return buf;
    });
    audioBuffers.set(ctx, list);
  }
  return list[id];
};

const postBuffers = (node: AudioWorkletNode, ids: Iterable<number>) => {
  for (const id of ids) {
    const b = rendered[id];
    node.port.postMessage({ type: 'buffer', id, l: b.l.slice(), r: b.r.slice() });
  }
};

interface Graph {
  ctx: BaseAudioContext;
  variant: Variant;
  tracks: number;
  inputs: AudioNode[];             // a: where a track's note nodes connect
  players: AudioWorkletNode[];     // c: one per track
  engine: AudioWorkletNode | null; // b
  probe: AudioWorkletNode;
  dsps: DeviceDSP[];
  nodes: number;                   // graph nodes made, sources aside
  // a: the streaming scheduler's state
  cursor: number; late: number; worstLateMs: number; sourcesMade: number; live: number; maxLive: number;
  start: number;                   // ctx time of song position 0
}

const modules = new WeakSet<BaseAudioContext>();
async function loadModules(ctx: BaseAudioContext) {
  if (modules.has(ctx)) return;
  await loadDeviceWorklets(ctx);
  await Promise.all([playerUrl, engineUrl, fdnUrl, probeUrl].map((u) => ctx.audioWorklet.addModule(u)));
  modules.add(ctx);
}

async function build(ctx: BaseAudioContext, variant: Variant, tracks: number): Promise<Graph> {
  await loadModules(ctx);
  const probe = new AudioWorkletNode(ctx, 'bench-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  const g: Graph = { ctx, variant, tracks, inputs: [], players: [], engine: null, probe, dsps: [], nodes: 1, cursor: 0, late: 0, worstLateMs: 0, sourcesMade: 0, live: 0, maxLive: 0, start: 0 };
  const kind = variant[0];
  const devices = !variant.endsWith('nodev');

  if (kind === 'b') {
    const engine = new AudioWorkletNode(ctx, 'bench-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { tracks, devices } });
    postBuffers(engine, rendered.map((b) => b.id));
    engine.connect(probe); probe.connect(ctx.destination);
    g.engine = engine; g.nodes += 1;
    return g;
  }

  // The native mixer: strips into a master limiter (as engine.ts builds it)
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
  master.connect(limiter); limiter.connect(probe); probe.connect(ctx.destination);
  g.nodes += 2;
  for (let t = 0; t < tracks; t++) {
    const input = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const fader = ctx.createGain();
    fader.gain.value = 0.8;
    g.nodes += 3;
    let prev: AudioNode = input;
    if (devices) {
      const chain = [DEVICE_DEFS.eq8.create(ctx), DEVICE_DEFS.compressor.create(ctx)];
      chain.forEach((d) => d.update(Object.fromEntries(DEVICE_DEFS[d === chain[0] ? 'eq8' : 'compressor'].params.map((p) => [p.name, p.default]))));
      g.nodes += 32 + 2 + 1;
      if (variant.endsWith('fdn')) {
        const fdn = new AudioWorkletNode(ctx, 'bench-fdn', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        chain.push({ input: fdn, output: fdn, update() {}, dispose() { fdn.disconnect(); } });
        g.nodes += 1;
      } else {
        const reverb = DEVICE_DEFS.reverb.create(ctx);
        reverb.update({ 'Dry/Wet': 30, Decay: 2.5 });
        chain.push(reverb);
        g.nodes += 5;
      }
      chain.forEach((d) => { prev.connect(d.input); prev = d.output; g.dsps.push(d); });
    }
    prev.connect(panner); panner.connect(fader); fader.connect(master);
    g.inputs.push(input);
    if (kind === 'c') {
      const player = new AudioWorkletNode(ctx, 'bench-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      postBuffers(player, new Set(Array.from({ length: 8 }, (_, i) => bufferId(t, i))));
      player.connect(input);
      g.players.push(player);
      g.nodes += 1;
    }
  }
  return g;
}

// ------------------------------------------------------------- scheduling

// (a): one AudioBufferSourceNode and gain per note, for song time [from, to)
function scheduleNodes(g: Graph, from: number, to: number) {
  const now = g.ctx.currentTime;
  for (let t = 0; t < g.tracks; t++) {
    for (const n of notesOf(t, from, to)) {
      const when = g.start + n.at;
      if (g.ctx instanceof AudioContext && when < now) { g.late++; g.worstLateMs = Math.max(g.worstLateMs, 1000 * (now - when)); }
      const src = g.ctx.createBufferSource();
      src.buffer = bufferFor(g.ctx, n.buf);
      const gain = g.ctx.createGain();
      gain.gain.value = VELOCITY;
      src.connect(gain); gain.connect(g.inputs[t]);
      src.start(Math.max(when, now));
      g.sourcesMade++;
      g.live++; g.maxLive = Math.max(g.maxLive, g.live);
      src.onended = () => { g.live--; src.disconnect(); gain.disconnect(); };
    }
  }
}

// (b) and (c): events posted to the worklets for song time [from, to)
function postNotes(g: Graph, from: number, to: number) {
  for (let t = 0; t < g.tracks; t++) {
    const notes = notesOf(t, from, to).map((n) => ({ buf: n.buf, at: g.start + n.at, gain: VELOCITY }));
    if (!notes.length) continue;
    if (g.engine) g.engine.port.postMessage({ type: 'notes', track: t, notes });
    else g.players[t].port.postMessage({ type: 'notes', notes });
  }
}

const schedule = (g: Graph, from: number, to: number) => (g.variant[0] === 'a' ? scheduleNodes(g, from, to) : postNotes(g, from, to));

const askStats = (node: AudioWorkletNode, message: unknown = { type: 'stats' }) => new Promise<any>((resolve) => {
  const listen = (e: MessageEvent) => { if (e.data?.type === 'stats') { node.port.removeEventListener('message', listen); resolve(e.data); } };
  node.port.addEventListener('message', listen);
  node.port.start();
  node.port.postMessage(message);
});

async function workletStats(g: Graph) {
  if (g.engine) return askStats(g.engine);
  if (g.players.length) {
    const all = await Promise.all(g.players.map((p) => askStats(p)));
    return { late: all.reduce((s, x) => s + x.late, 0), worstLateMs: Math.max(...all.map((x) => x.worstLateMs)), played: all.reduce((s, x) => s + x.played, 0) };
  }
  return { late: g.late, worstLateMs: g.worstLateMs, played: g.sourcesMade };
}

// ------------------------------------------------------------ measurements

// Offline: `seconds` of the song rendered as fast as the machine can.
// speed = song seconds per wall second; load = 1 / speed is the share of
// a render thread the same work takes in real time.
export async function offline(variant: Variant, seconds: number, tracks: number, sampleRate = 44100) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const g = await build(ctx, variant, tracks);
  g.start = 0;
  const t0 = performance.now();
  schedule(g, 0, seconds);
  const scheduled = performance.now() - t0;
  const t1 = performance.now();
  const out = await ctx.startRendering();
  const wall = (performance.now() - t1) / 1000;
  let peak = 0;
  const d = out.getChannelData(0);
  for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i]));
  const stats = await workletStats(g).catch(() => null);
  return { variant, tracks, seconds, wallSeconds: wall, speed: seconds / wall, load: wall / seconds, scheduleMs: scheduled, nodes: g.nodes, sources: g.sourcesMade, peak, played: stats?.played ?? null, workletLoad: stats?.load ?? null, perTrack: stats?.perTrack ?? null, pendingLeft: stats?.pendingLeft ?? null, messages: stats?.messages ?? null, late: stats?.late ?? null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stall = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* the main thread is busy */ } };

// Real time: play `seconds` with the scheduler running a window ahead
// (a: `window` seconds of nodes; b, c: `window` seconds of events), with
// main-thread stalls injected at `stalls` ({ at, ms }). Reports late notes
// (committed after their time), the render thread falling behind, and the
// drift between the audio clock and the wall clock.
export async function realtime(variant: Variant, seconds: number, tracks: number, window: number, stalls: { at: number; ms: number }[]) {
  const ctx = new AudioContext();
  await ctx.resume();
  const g = await build(ctx, variant, tracks);
  await sleep(200);
  g.start = ctx.currentTime + 0.2;
  const wall0 = performance.now(), audio0 = ctx.currentTime;
  const tickMs = 25;
  let tickTime = 0, ticks = 0, worstTickMs = 0;
  const tick = () => {
    const t0 = performance.now();
    const horizon = ctx.currentTime - g.start + window;
    const to = Math.min(seconds, horizon);
    if (to > g.cursor) { schedule(g, g.cursor, to); g.cursor = to; }
    const dt = performance.now() - t0;
    tickTime += dt; ticks++; worstTickMs = Math.max(worstTickMs, dt);
  };
  tick();
  const timer = setInterval(tick, tickMs);
  for (const s of stalls) setTimeout(() => stall(s.ms), s.at * 1000);
  await sleep((seconds + 0.5) * 1000);
  clearInterval(timer);
  const probe = await askStats(g.probe, 'stats');
  const stats = await workletStats(g);
  const drift = (performance.now() - wall0) / 1000 - (ctx.currentTime - audio0);
  await ctx.close();
  return {
    variant, tracks, seconds, window, stalls,
    late: stats.late, worstLateMs: stats.worstLateMs, played: stats.played,
    behindMs: probe.behindMs, behindBlocks: probe.behindBlocks, driftMs: drift * 1000,
    tickMs: ticks ? tickTime / ticks : 0, worstTickMs, ticks, maxLive: g.maxLive, nodes: g.nodes,
    workletLoad: stats.load ?? null
  };
}

// Live input: the time from "play this now" on the main thread to the first
// sample of sound, through each variant's path, idle or with the project
// playing. A click buffer, so the onset is its first sample.
export async function latency(variant: Variant, tracks: number, loaded: boolean, triggers = 12) {
  const ctx = new AudioContext();
  await ctx.resume();
  await loadModules(ctx);
  const click = ctx.createBuffer(2, 2048, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = click.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.5 * (1 - i / d.length); }
  const probe = new AudioWorkletNode(ctx, 'bench-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  const mute = ctx.createGain(); mute.gain.value = 0;
  probe.connect(mute); mute.connect(ctx.destination);
  const onsets: number[] = [];
  probe.port.onmessage = (e) => { if (e.data?.type === 'onset') onsets.push(e.data.frame); };

  let fire: (at: number) => void;
  const kind = variant[0];
  if (kind === 'a') {
    fire = (at) => { const src = ctx.createBufferSource(); src.buffer = click; src.connect(probe); src.start(at); };
  } else {
    const node = kind === 'b'
      ? new AudioWorkletNode(ctx, 'bench-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { tracks: 1, devices: false } })
      : new AudioWorkletNode(ctx, 'bench-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const id = 999;
    node.port.postMessage({ type: 'buffer', id, l: click.getChannelData(0).slice(), r: click.getChannelData(1).slice() });
    node.connect(probe);
    fire = (at) => node.port.postMessage(kind === 'b' ? { type: 'notes', track: 0, notes: [{ buf: id, at, gain: 1 }] } : { type: 'notes', notes: [{ buf: id, at, gain: 1 }] });
  }

  let g: Graph | null = null, timer: ReturnType<typeof setInterval> | null = null;
  if (loaded) {
    g = await build(ctx, variant, tracks);
    g.start = ctx.currentTime + 0.2;
    timer = setInterval(() => { const to = ctx.currentTime - g!.start + 0.5; if (to > g!.cursor) { schedule(g!, g!.cursor, to); g!.cursor = to; } }, 25);
  }
  await sleep(500);
  const requested: number[] = [];
  for (let i = 0; i < triggers; i++) {
    const at = ctx.currentTime;
    requested.push(at);
    fire(at);
    await sleep(250);
  }
  await sleep(200);
  if (timer) clearInterval(timer);
  await ctx.close();
  const ms = requested.map((at, i) => (onsets[i] === undefined ? null : 1000 * (onsets[i] / ctx.sampleRate - at))).filter((x): x is number => x !== null);
  ms.sort((a, b) => a - b);
  return { variant, loaded, triggers, measured: ms.length, minMs: ms[0], medianMs: ms[Math.floor(ms.length / 2)], maxMs: ms[ms.length - 1], baseLatencyMs: 1000 * ctx.baseLatency, quantumMs: 1000 * 128 / ctx.sampleRate };
}

// What a whole-segment schedule costs the main thread: creating and starting
// `count` note nodes at once
export async function nodeCost(count: number) {
  const ctx = new AudioContext();
  await ctx.resume();
  const buf = bufferFor(ctx, 0);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
  const t0 = performance.now();
  const made: AudioBufferSourceNode[] = [];
  for (let i = 0; i < count; i++) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    src.connect(gain); gain.connect(sink);
    src.start(ctx.currentTime + 100 + i * 0.001);
    made.push(src);
  }
  const ms = performance.now() - t0;
  await sleep(100);
  const t1 = performance.now();
  made.forEach((s) => s.stop());
  const stopMs = performance.now() - t1;
  await ctx.close();
  return { count, ms, perThousandMs: 1000 * ms / count, stopMs };
}

(window as any).bench = { prepare, offline, realtime, latency, nodeCost };
(window as any).benchReady = true;
