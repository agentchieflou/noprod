// Renders a sound recipe to stereo samples.
//
// Each layer makes its frequencies (sine partials, a band-limited harmonic
// series, an FM pair or noise), runs them through its filters, its amplitude
// envelope and its drive, and is panned into the mix. The result is the same
// for the same recipe, note, velocity and gate, noise included.

import {
  EnvelopeGenerator, StateVariableFilter, createRandom, decayCoefficient, hashString,
  midiToHz, readTable, releaseTime, sine, tableFor, waveTables
} from './dsp.ts';
import { loudness } from './analysis.ts';
import type {
  Filter, FmLayer, Layer, NoiseLayer, PartialsLayer, RenderOptions, RenderedSound, SoundRecipe, WaveLayer
} from './types.ts';

const DEFAULT_RATE = 44100;
const MAX_SECONDS = 30;       // longest render, however long the gate
const MAX_TAIL = 10;          // longest release after the note-off
const BLOCK = 16;             // samples between filter cutoff updates
const SILENT = 1e-6;          // an envelope this low has ended (-120 dB)
const TRIM_FLOOR = 1e-5;      // trailing samples below -100 dB are cut off
const END_FADE = 0.005;       // fade where the length cuts a sound short
const PEAK_TARGET = Math.pow(10, -1 / 20);   // normalized peak: at most -1 dBFS
const LOUDNESS_TARGET = -12;                 // LUFS over the loudest 100 ms (analysis.ts loudness)

interface Context {
  sampleRate: number;
  frames: number;
  gate: number;        // sample of the note-off (Infinity: none)
  pitchScale: number;  // frequency multiplier from the note and transpose
  rootHz: number;
  velocity: number;
  seed: number;
}

// --------------------------------------------------------------------- api

export function render(recipe: SoundRecipe, options: RenderOptions = {}): RenderedSound {
  const sampleRate = options.sampleRate ?? DEFAULT_RATE;
  const sound = renderRaw(recipe, options, sampleRate);
  if (options.normalize !== false) {
    const gain = loudnessGain(recipe, sampleRate) * Math.pow(10, (recipe.gain ?? 0) / 20);
    for (let i = 0; i < sound.left.length; i++) {
      sound.left[i] *= gain;
      sound.right[i] *= gain;
    }
  }
  return sound;
}

// How much `render` scales a recipe so every sound sounds equally loud (the
// loudest 100 ms, K-weighted, at -12 LUFS, peaks at most -1 dBFS): measured
// once, at the root note, full velocity. Cached per recipe object,
// so treat recipes as immutable (edit a copy).
const loudnessCache = new WeakMap<SoundRecipe, Map<number, number>>();

export function loudnessGain(recipe: SoundRecipe, sampleRate = DEFAULT_RATE) {
  let byRate = loudnessCache.get(recipe);
  if (!byRate) loudnessCache.set(recipe, (byRate = new Map()));
  const cached = byRate.get(sampleRate);
  if (cached !== undefined) return cached;

  const { left, right } = renderRaw(recipe, {}, sampleRate);
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = peak > 0
    ? Math.min(PEAK_TARGET / peak, Math.pow(10, (LOUDNESS_TARGET - loudness(left, right, sampleRate)) / 20))
    : 1;
  byRate.set(sampleRate, gain);
  return gain;
}

// ---------------------------------------------------------------- the mix

function renderRaw(recipe: SoundRecipe, options: RenderOptions, sampleRate: number): RenderedSound {
  const root = recipe.root ?? 60;
  const note = options.note ?? root;
  const semitones = (recipe.pitched ? note - root : 0) + (options.transpose ?? 0);

  // A pitched note holds until its gate, then rings out its longest release;
  // a one-shot plays its whole length whatever the gate
  let seconds = recipe.length;
  let gate = Infinity;
  if (recipe.pitched) {
    const held = Math.max(0, options.gate ?? recipe.length);
    const tail = Math.min(MAX_TAIL, Math.max(0, ...recipe.layers.map(longestRelease)));
    seconds = held + tail;
    gate = Math.round(held * sampleRate);
  }
  const frames = Math.max(1, Math.ceil(Math.min(seconds, MAX_SECONDS) * sampleRate));

  const ctx: Context = {
    sampleRate,
    frames,
    gate,
    pitchScale: Math.pow(2, semitones / 12),
    rootHz: midiToHz(root),
    velocity: Math.min(1, Math.max(0, options.velocity ?? 1)),
    seed: (recipe.seed ?? 0) ^ hashString(recipe.id)
  };

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  recipe.layers.forEach((layer, i) => renderLayer(layer, i, ctx, left, right));
  return trim(left, right, sampleRate);
}

const longestRelease = (layer: Layer) => Math.max(
  releaseTime(layer.env),
  ...filtersOf(layer).map((f) => (f.env ? releaseTime(f.env) : 0))
);

const filtersOf = (layer: Layer): Filter[] =>
  !layer.filter ? [] : Array.isArray(layer.filter) ? layer.filter : [layer.filter];

// Cut the silence after the sound ends, and fade out a sound its length cuts off
function trim(left: Float32Array, right: Float32Array, sampleRate: number): RenderedSound {
  let end = left.length;
  while (end > 0 && Math.abs(left[end - 1]) < TRIM_FLOOR && Math.abs(right[end - 1]) < TRIM_FLOOR) end--;
  if (end === left.length) {
    const fade = Math.min(end, Math.round(END_FADE * sampleRate));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      left[end - 1 - i] *= g;
      right[end - 1 - i] *= g;
    }
  }
  end = Math.max(end, 1);
  return { sampleRate, left: left.slice(0, end), right: right.slice(0, end) };
}

// Equal-power pan, scaled so the centre is unity on both sides
function panGains(pan: number): [number, number] {
  const p = Math.min(1, Math.max(-1, pan));
  if (p === 0) return [1, 1];
  const angle = (p + 1) * (Math.PI / 4);
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

// Fades a component out as it nears Nyquist, so a sweep across it doesn't click
function nyquistFade(hz: number, nyquist: number) {
  const x = (nyquist * 0.95 - hz) / (nyquist * 0.05);
  return x >= 1 ? 1 : x <= 0 ? 0 : x;
}

// -------------------------------------------------------------- one layer

function renderLayer(layer: Layer, index: number, ctx: Context, left: Float32Array, right: Float32Array) {
  const sr = ctx.sampleRate;
  const offset = Math.round((layer.start ?? 0) * sr);
  if (offset >= ctx.frames) return;
  const gate = ctx.gate - offset;

  // The amplitude envelope first: nothing after it falls silent needs making
  const envelope = new EnvelopeGenerator(layer.env, sr, gate);
  const amp = new Float32Array(ctx.frames - offset);
  let frames = 0;
  for (; frames < amp.length; frames++) {
    amp[frames] = envelope.next();
    if (envelope.finished(SILENT)) break;
  }
  if (frames === 0) return;

  const baseHz = (layer.hz ?? ctx.rootHz * (layer.ratio ?? 1)) * ctx.pitchScale;
  const bend = pitchCurve(layer, frames, sr);
  const random = createRandom(ctx.seed + index * 7919);
  const srcL = new Float32Array(frames);
  let srcR: Float32Array | null = null;

  switch (layer.type) {
    case 'partials': srcR = partialsSource(layer, ctx, baseHz, bend, random, srcL); break;
    case 'wave': srcR = waveSource(layer, ctx, baseHz, bend, random, srcL); break;
    case 'fm': fmSource(layer, ctx, gate, baseHz, bend, srcL); break;
    case 'noise': srcR = noiseSource(layer, random, srcL); break;
  }

  for (const filter of filtersOf(layer)) {
    applyFilter(filter, ctx, gate, srcL);
    if (srcR) applyFilter(filter, ctx, gate, srcR);
  }

  const level = (layer.level ?? 1) * (1 - (layer.velocity ?? 1) * (1 - ctx.velocity * ctx.velocity));
  const k = 1 + (layer.drive ?? 0);
  const driveNorm = layer.drive ? 1 / Math.tanh(k) : 1;
  const shape = (x: number) => (layer.drive ? Math.tanh(k * x) * driveNorm : x);

  if (srcR) {
    // A stereo layer: pan balances it
    const pan = layer.pan ?? 0;
    const gl = level * Math.min(1, 1 - pan);
    const gr = level * Math.min(1, 1 + pan);
    for (let i = 0; i < frames; i++) {
      left[offset + i] += shape(srcL[i] * amp[i]) * gl;
      right[offset + i] += shape(srcR[i] * amp[i]) * gr;
    }
  } else {
    const [pl, pr] = panGains(layer.pan ?? 0);
    for (let i = 0; i < frames; i++) {
      const x = shape(srcL[i] * amp[i]) * level;
      left[offset + i] += x * pl;
      right[offset + i] += x * pr;
    }
  }
}

// The layer's frequency multiplier over time: pitch envelope and vibrato
function pitchCurve(layer: Layer, frames: number, sr: number): Float64Array | null {
  const { pitch, vibrato } = layer;
  if (!pitch && !vibrato) return null;
  const out = new Float64Array(frames);
  let semitones = pitch?.amount ?? 0;
  const glide = pitch ? decayCoefficient(pitch.time, sr) : 0;
  for (let i = 0; i < frames; i++) {
    let cents = semitones * 100;
    if (vibrato) {
      const t = i / sr - (vibrato.delay ?? 0);
      if (t > 0) {
        const depth = vibrato.fade ? Math.min(1, t / vibrato.fade) : 1;
        cents += vibrato.depth * depth * sine(vibrato.rate * t);
      }
    }
    out[i] = Math.pow(2, cents / 1200);
    semitones *= glide;
  }
  return out;
}

function applyFilter(filter: Filter, ctx: Context, gate: number, x: Float32Array) {
  const sr = ctx.sampleRate;
  const stages = filter.slope === 24 ? [new StateVariableFilter(filter.type), new StateVariableFilter(filter.type)]
    : [new StateVariableFilter(filter.type)];
  const q = filter.q ?? 0.707;
  const base = filter.cutoff
    * Math.pow(ctx.pitchScale, filter.keyTrack ?? 0)
    * Math.pow(2, (filter.velocity ?? 0) * ctx.velocity);
  const env = filter.env ? new EnvelopeGenerator(filter.env, sr, gate) : null;
  const amount = filter.env?.amount ?? 0;

  for (let i = 0; i < x.length; i++) {
    const e = env ? env.next() : 0;
    if (i % BLOCK === 0) {
      const cutoff = env ? base * Math.pow(2, amount * e) : base;
      for (const s of stages) s.set(cutoff, q, sr);
    }
    let y = x[i];
    for (const s of stages) y = s.process(y);
    x[i] = y;
  }
}

// ----------------------------------------------------------------- sources
// Each writes the layer's raw signal into `out` (the left channel) and
// returns a right channel when the layer is stereo.

function partialsSource(
  layer: PartialsLayer, ctx: Context, baseHz: number, bend: Float64Array | null, random: () => number, out: Float32Array
): Float32Array | null {
  const sr = ctx.sampleRate;
  const nyquist = sr / 2;
  const stretch = layer.stretch ?? 0;
  const partials = [...(layer.partials ?? [])];
  if (layer.series) {
    const { count, slope = -6, odd = 1, even = 1 } = layer.series;
    for (let n = 1; n <= count; n++) {
      partials.push({ ratio: n, level: Math.pow(n, slope / (20 * Math.log10(2))) * (n % 2 ? odd : even) });
    }
  }
  const stereo = partials.some((p) => p.pan);
  const right = stereo ? new Float32Array(out.length) : null;

  for (const p of partials) {
    const ratio = p.ratio * Math.sqrt(1 + stretch * p.ratio * p.ratio) * Math.pow(2, (p.detune ?? 0) / 1200);
    const hz0 = baseHz * ratio;
    if (!bend && hz0 >= nyquist * 0.95) continue;
    const t60 = p.decay ?? (layer.partialDecay ? layer.partialDecay / Math.pow(p.ratio, layer.damping ?? 0) : 0);
    const coef = t60 > 0 ? decayCoefficient(t60, sr) : 1;
    const attack = Math.round((p.attack ?? 0) * sr);
    const [pl, pr] = stereo ? panGains(p.pan ?? 0) : [1, 0];
    let level = p.level;
    let phase = layer.phases === 'random' ? random() : 0;

    for (let i = 0; i < out.length; i++) {
      const hz = bend ? hz0 * bend[i] : hz0;
      let a = level * nyquistFade(hz, nyquist);
      if (i < attack) a *= i / attack;
      const s = a * sine(phase);
      out[i] += s * pl;
      if (right) right[i] += s * pr;
      phase += hz / sr;
      if (phase >= 1) phase -= Math.floor(phase);
      level *= coef;
      if (level < SILENT * 1e-2) break;
    }
  }
  return right;
}

function waveSource(
  layer: WaveLayer, ctx: Context, baseHz: number, bend: Float64Array | null, random: () => number, out: Float32Array
): Float32Array | null {
  const sr = ctx.sampleRate;
  const tables = waveTables(layer.shape ?? 'saw', layer.width ?? 0.25, layer.harmonics);
  const ratios = layer.ratios ?? [1];
  const voices = Math.max(1, Math.round(layer.unison?.voices ?? 1));
  const detune = layer.unison?.detune ?? 0;
  const spread = layer.unison?.spread ?? 0;
  const right = voices > 1 && spread > 0 ? new Float32Array(out.length) : null;
  const count = ratios.length * voices;
  const norm = 1 / Math.sqrt(count);

  for (const ratio of ratios) {
    for (let v = 0; v < voices; v++) {
      const position = voices > 1 ? v / (voices - 1) : 0.5;
      const hz0 = baseHz * ratio * Math.pow(2, (detune * (position - 0.5)) / 1200);
      const [pl, pr] = right ? panGains(spread * (position * 2 - 1)) : [1, 0];
      let phase = count > 1 ? random() : 0;
      let table: Float32Array | null = null;
      for (let i = 0; i < out.length; i++) {
        const hz = bend ? hz0 * bend[i] : hz0;
        if (i % BLOCK === 0) table = tableFor(tables, hz, sr);
        if (table) {
          const s = readTable(table, phase) * norm;
          out[i] += s * pl;
          if (right) right[i] += s * pr;
        }
        phase += hz / sr;
        if (phase >= 1) phase -= Math.floor(phase);
      }
    }
  }
  return right;
}

function fmSource(layer: FmLayer, ctx: Context, gate: number, baseHz: number, bend: Float64Array | null, out: Float32Array) {
  const sr = ctx.sampleRate;
  const nyquist = sr / 2;
  const indexEnv = layer.indexEnv ? new EnvelopeGenerator(layer.indexEnv, sr, gate) : null;
  // Harder hits are brighter
  const index = layer.index * (0.5 + 0.5 * ctx.velocity);
  const feedback = (layer.feedback ?? 0) * Math.PI;
  let carrier = 0;
  let modulator = 0;
  let previous = 0;
  for (let i = 0; i < out.length; i++) {
    const hz = bend ? baseHz * bend[i] : baseHz;
    const depth = index * (indexEnv ? indexEnv.next() : 1);
    const m = Math.sin(2 * Math.PI * modulator + feedback * previous);
    previous = m;
    out[i] = sine(carrier + (depth * m) / (2 * Math.PI)) * nyquistFade(hz, nyquist);
    carrier += hz / sr;
    modulator += (hz * layer.modRatio) / sr;
    if (carrier >= 1) carrier -= Math.floor(carrier);
    if (modulator >= 1) modulator -= Math.floor(modulator);
  }
}

function noiseSource(layer: NoiseLayer, random: () => number, out: Float32Array): Float32Array | null {
  const right = layer.stereo ? new Float32Array(out.length) : null;
  const fill = (x: Float32Array) => {
    // Pink: Paul Kellet's filter; brown: leaky integration
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let i = 0; i < x.length; i++) {
      const white = random() * 2 - 1;
      switch (layer.color ?? 'white') {
        case 'white':
          x[i] = white;
          break;
        case 'pink': {
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
          break;
        }
        case 'brown':
          brown = (brown + 0.02 * white) / 1.02;
          x[i] = brown * 3.5;
          break;
      }
    }
  };
  fill(out);
  if (right) fill(right);
  return right;
}
