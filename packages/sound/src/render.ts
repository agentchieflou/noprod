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
import { ModelVoice, closedLoop, modelTail, modelTuning, stringSets } from './model.ts';
import type {
  Filter, FmLayer, ModelLayer, Layer, NoiseLayer, PartialsLayer, RenderOptions, RenderedSound, SoundRecipe, WaveLayer
} from './types.ts';

const DEFAULT_RATE = 44100;
const MAX_SECONDS = 30;       // longest render, however long the gate
const MAX_TAIL = 10;          // longest release after the note-off
const BLOCK = 16;             // samples between filter cutoff updates
const SILENT = 1e-6;          // an envelope this low has ended (-120 dB)
const TRIM_FLOOR = 1e-5;      // trailing samples below -100 dB are cut off
const END_FADE = 0.005;       // fade where the length cuts a sound short
const GATE = { attack: 0.001, sustain: 1, release: 0.005 }; // a bypassed envelope: on while held
const PEAK_TARGET = Math.pow(10, -1 / 20);   // normalized peak: at most -1 dBFS
const LOUDNESS_TARGET = -12;                 // LUFS over the loudest 100 ms (analysis.ts loudness)

// What a note needs to know: its rate, pitch, velocity and noise
export interface NoteContext {
  sampleRate: number;
  rootHz: number;
  pitchScale: number;  // frequency multiplier from the note and transpose
  velocity: number;
  seed: number;
}

interface Context extends NoteContext {
  frames: number;
  gate: number;        // sample of the note-off (Infinity: none)
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

// The same sound under another id: the seed changes with it, so the noise
// (seeded from both) stays exactly the same
export const withId = (recipe: SoundRecipe, id: string): SoundRecipe =>
  ({ ...recipe, id, seed: ((recipe.seed ?? 0) ^ hashString(recipe.id) ^ hashString(id)) >>> 0 });

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
    seed: noteSeed(recipe)
  };

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  recipe.layers.forEach((layer, i) => { if (!layer.mute) renderLayer(layer, i, ctx, left, right); });
  return trim(left, right, sampleRate);
}

// Where a recipe's noise starts (the same for every render of it)
export const noteSeed = (recipe: SoundRecipe) => (recipe.seed ?? 0) ^ hashString(recipe.id);

const longestRelease = (layer: Layer) => layer.mute ? 0 : Math.max(
  releaseTime(layer.env),
  ...filtersOf(layer).map((f) => (f.env ? releaseTime(f.env) : 0)),
  layer.type === 'model' ? Math.min((closedLoop(layer.exciter) ? releaseOf(layer, new Set(layer.bypass)) : 0) + modelTail(layer), MAX_TAIL) : 0
);
// The release's T60: how long the player takes to stop
const releaseOf = (layer: Layer, off: Set<string>) => (off.has('env') ? GATE : layer.env)?.release ?? 0.05;

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
  const off = new Set(layer.bypass ?? []);
  if (off.has('source')) return;

  // A physical model plays a sample at a time, as a live note does
  if (layer.type === 'model') {
    const voice = new ModelLayerVoice(layer, index, ctx, { gate, frames: ctx.frames - offset });
    for (let i = 0; voice.next(); i++) {
      const x = voice.out * voice.level;
      left[offset + i] += x * voice.pl;
      right[offset + i] += x * voice.pr;
    }
    return;
  }

  // The amplitude envelope first: nothing after it falls silent needs making.
  // (Bypassed, the layer just sounds while the note is held.)
  const envelope = new EnvelopeGenerator(off.has('env') ? GATE : layer.env, sr, gate);
  const amp = new Float32Array(ctx.frames - offset);
  let frames = 0;
  for (; frames < amp.length; frames++) {
    amp[frames] = envelope.next();
    if (envelope.finished(SILENT)) break;
  }
  if (frames === 0) return;

  const baseHz = (layer.hz ?? ctx.rootHz * (layer.ratio ?? 1)) * ctx.pitchScale;
  const bend = pitchCurve(layer, frames, sr, off);
  const random = createRandom(ctx.seed + index * 7919);
  const srcL = new Float32Array(frames);
  let srcR: Float32Array | null = null;

  switch (layer.type) {
    case 'partials': srcR = partialsSource(layer, ctx, baseHz, bend, random, srcL); break;
    case 'wave': srcR = waveSource(layer, ctx, baseHz, bend, random, srcL); break;
    case 'fm': fmSource(layer, ctx, gate, baseHz, bend, srcL); break;
    case 'noise': srcR = noiseSource(layer, random, srcL); break;
  }

  filtersOf(layer).forEach((filter, k) => {
    if (off.has(`filter:${k}`)) return;
    applyFilter(filter, ctx, gate, srcL);
    if (srcR) applyFilter(filter, ctx, gate, srcR);
  });

  const gain = amp;
  if (layer.tremolo && !off.has('tremolo')) {
    const { rate, depth, delay = 0 } = layer.tremolo;
    for (let i = 0; i < frames; i++) {
      const t = i / sr - delay;
      if (t > 0) gain[i] *= 1 - depth * (0.5 - 0.5 * sine(rate * t + 0.25));
    }
  }

  const level = (layer.level ?? 1) * (1 - (layer.velocity ?? 1) * (1 - ctx.velocity * ctx.velocity));

  // The envelope, then drive; saturating an uneven wave shifts it off
  // centre, so a DC blocker follows, as AC coupling would in a circuit
  for (const x of srcR ? [srcL, srcR] : [srcL]) {
    for (let i = 0; i < frames; i++) x[i] *= gain[i];
    if (layer.drive && !off.has('drive')) drive(x, layer.drive, sr);
  }

  if (srcR) {
    // A stereo layer: pan balances it
    const pan = layer.pan ?? 0;
    const gl = level * Math.min(1, 1 - pan);
    const gr = level * Math.min(1, 1 + pan);
    for (let i = 0; i < frames; i++) {
      left[offset + i] += srcL[i] * gl;
      right[offset + i] += srcR[i] * gr;
    }
  } else {
    const [pl, pr] = panGains(layer.pan ?? 0);
    for (let i = 0; i < frames; i++) {
      const x = srcL[i] * level;
      left[offset + i] += x * pl;
      right[offset + i] += x * pr;
    }
  }
}

// ---------------------------------------------------- a model layer's note

// The lowest a layer's own glide and vibrato take its pitch
const lowestBend = (layer: Layer, off: Set<string>) =>
  Math.pow(2, (Math.min(0, off.has('pitch') ? 0 : layer.pitch?.amount ?? 0) * 100 - (off.has('vibrato') ? 0 : layer.vibrato?.depth ?? 0)) / 1200);

// One note of a model layer, a sample at a time (#106), as a rendered note
// plays it: the envelope (the player's input to a bow or breath, or the
// damper on a plucked string), the pitch glide and vibrato, the model, its
// filters, the fade as it rings out, tremolo and drive. A rendered note
// knows its gate; a live one is let go with `release()`. Each `next()`
// makes a sample, `out`, to be scaled by `level` and panned by `pl` and
// `pr`; it is false once the layer has stopped sounding. A live note also
// bends (a frequency multiplier) and swells (`expression` scales the
// player's input to a bow or breath). The stages meet in
// 32-bit floats, as a rendered layer's buffers do, so the two agree to the bit.
//
//   gate        the note-off, in samples (a rendered note)
//   frames      the most it may play (a rendered note's length)
//   tune        a closed loop's tuning (else measured here: not on the audio thread)
//   lowestBend  the lowest it will bend to, beyond its own glide and vibrato
export class ModelLayerVoice {
  out = 0;
  readonly level: number;
  readonly pl: number;
  readonly pr: number;
  private readonly sr: number;
  private readonly envelope: EnvelopeGenerator;
  private readonly pitch: PitchCurve | null;
  private readonly voice: ModelVoice;
  private readonly filters: FilterVoice[];
  private readonly shaped: boolean;
  private readonly closed: boolean;
  private readonly letGo: number;   // how long the player takes to stop (a closed loop), in samples
  private readonly tail: number;    // how long it rings on once nothing excites it, in samples
  private readonly fall: number;
  private readonly tremolo: Layer['tremolo'] | null;
  private readonly drive: Drive | null;
  private readonly frames: number;
  private i = 0;
  private gate: number;
  private envEnd = Infinity;        // where the envelope fell silent
  private g = 1;                    // the ring-out fade

  constructor(layer: ModelLayer, index: number, note: NoteContext, options: { gate?: number; frames?: number; tune?: number; lowestBend?: number } = {}) {
    const sr = this.sr = note.sampleRate;
    const off = new Set(layer.bypass ?? []);
    this.gate = options.gate ?? Infinity;
    this.frames = options.frames ?? Infinity;
    // (bypassed, the envelope just sounds while the note is held)
    this.envelope = new EnvelopeGenerator(off.has('env') ? GATE : layer.env, sr, this.gate);
    this.pitch = PitchCurve.of(layer, sr, off);
    const baseHz = (layer.hz ?? note.rootHz * (layer.ratio ?? 1)) * note.pitchScale;
    const r = { sampleRate: sr, baseHz, velocity: note.velocity, seed: note.seed + index * 7919, off };
    this.closed = closedLoop(layer.exciter);
    const tuned = this.closed && !off.has('resonator') && !off.has('exciter');
    this.voice = new ModelVoice(layer, r, options.tune ?? (tuned ? modelTuning(layer, r) : 1), lowestBend(layer, off) * (options.lowestBend ?? 1), tuned);
    this.filters = filtersOf(layer).flatMap((f, k) => (off.has(`filter:${k}`) ? [] : [new FilterVoice(f, note, this.gate)]));
    // The envelope shapes the sound, except where it's the player's input to a
    // closed-loop exciter (bow speed, breath), or the damper on strings that
    // share a bridge: the model shapes itself then
    this.shaped = !(this.closed || stringSets(layer, off).length > 0);
    this.letGo = Math.round(releaseOf(layer, off) * sr);
    this.tail = Math.round(modelTail(layer) * sr);
    this.fall = decayCoefficient(modelTail(layer), sr);
    this.tremolo = layer.tremolo && !off.has('tremolo') ? layer.tremolo : null;
    this.drive = layer.drive && !off.has('drive') ? new Drive(layer.drive, sr) : null;
    this.level = (layer.level ?? 1) * (1 - (layer.velocity ?? 1) * (1 - note.velocity * note.velocity));
    const [pl, pr] = panGains(layer.pan ?? 0);
    this.pl = pl;
    this.pr = pr;
  }

  // The key is let go now
  release() {
    if (this.gate <= this.i) return;
    this.gate = this.i;
    this.envelope.release();
    for (let k = 0; k < this.filters.length; k++) this.filters[k].release();
  }

  next(bend = 1, expression = 1) {
    const i = this.i;
    if (i >= this.frames) return false;
    let amp = 0;
    if (this.envEnd === Infinity) {
      amp = Math.fround(this.envelope.next());
      if (this.envelope.finished(SILENT)) this.envEnd = i;
    }
    // It rings on after the player stops: a plucked string from when its
    // damper has silenced it, a bowed or blown one from when the player's
    // input has fallen 60 dB (its ring-out is its own, not the envelope's)
    const playing = this.closed ? Math.min(this.envEnd, this.gate + this.letGo) : this.envEnd;
    if (i >= playing + this.tail) return false;

    let x = this.voice.tick(this.closed ? amp * expression : amp, (this.pitch ? this.pitch.next() : 1) * bend);
    for (let k = 0; k < this.filters.length; k++) x = Math.fround(this.filters[k].tick(x));
    // (a closed-loop model fades out over its ring-out once the player stops;
    // plucked strings at a bridge ring out by themselves)
    let gain = this.shaped ? amp : 1;
    if (this.closed && i >= playing) gain = Math.fround((this.g *= this.fall));
    const tremolo = this.tremolo;
    if (tremolo) {
      const t = i / this.sr - (tremolo.delay ?? 0);
      if (t > 0) gain = Math.fround(gain * (1 - tremolo.depth * (0.5 - 0.5 * sine(tremolo.rate * t + 0.25))));
    }
    x = Math.fround(x * gain);
    if (this.drive) x = Math.fround(this.drive.tick(x));
    this.out = x;
    this.i++;
    return true;
  }
}

// tanh saturation (a full-scale input stays at full scale), then a 3 Hz DC blocker
class Drive {
  private readonly k: number;
  private readonly norm: number;
  private readonly r: number;
  private previousIn = 0;
  private previousOut = 0;
  constructor(amount: number, sr: number) {
    this.k = 1 + amount;
    this.norm = 1 / Math.tanh(this.k);
    this.r = 1 - (2 * Math.PI * 3) / sr;
  }
  tick(x: number) {
    const shaped = Math.tanh(this.k * x) * this.norm;
    this.previousOut = shaped - this.previousIn + this.r * this.previousOut;
    this.previousIn = shaped;
    return this.previousOut;
  }
}

function drive(x: Float32Array, amount: number, sr: number) {
  const d = new Drive(amount, sr);
  for (let i = 0; i < x.length; i++) x[i] = d.tick(x[i]);
}

// The layer's frequency multiplier over time: pitch envelope and vibrato
// The layer's pitch glide and vibrato, a sample at a time, as a frequency
// multiplier (`of` gives null if it has neither)
class PitchCurve {
  private readonly vibrato: Layer['vibrato'];
  private readonly glide: number;
  private readonly sr: number;
  private semitones: number;
  private i = 0;
  private constructor(layer: Layer, sr: number, off: Set<string>) {
    const pitch = off.has('pitch') ? undefined : layer.pitch;
    this.vibrato = off.has('vibrato') ? undefined : layer.vibrato;
    this.semitones = pitch?.amount ?? 0;
    this.glide = pitch ? decayCoefficient(pitch.time, sr) : 0;
    this.sr = sr;
  }
  static of(layer: Layer, sr: number, off: Set<string>) {
    return (!off.has('pitch') && layer.pitch) || (!off.has('vibrato') && layer.vibrato) ? new PitchCurve(layer, sr, off) : null;
  }
  next() {
    let cents = this.semitones * 100;
    const vibrato = this.vibrato;
    if (vibrato) {
      const t = this.i / this.sr - (vibrato.delay ?? 0);
      if (t > 0) {
        const depth = vibrato.fade ? Math.min(1, t / vibrato.fade) : 1;
        cents += vibrato.depth * depth * sine(vibrato.rate * t);
      }
    }
    this.semitones *= this.glide;
    this.i++;
    return Math.pow(2, cents / 1200);
  }
}

function pitchCurve(layer: Layer, frames: number, sr: number, off: Set<string>): Float64Array | null {
  const curve = PitchCurve.of(layer, sr, off);
  if (!curve) return null;
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) out[i] = curve.next();
  return out;
}

// One filter, a sample at a time: its cutoff from the note and velocity,
// moved by its own envelope
class FilterVoice {
  private readonly stages: StateVariableFilter[];
  private readonly q: number;
  private readonly base: number;
  private readonly sr: number;
  private readonly env: EnvelopeGenerator | null;
  private readonly amount: number;
  private i = 0;
  constructor(filter: Filter, ctx: NoteContext, gate: number) {
    this.sr = ctx.sampleRate;
    this.stages = filter.slope === 24 ? [new StateVariableFilter(filter.type), new StateVariableFilter(filter.type)]
      : [new StateVariableFilter(filter.type)];
    this.q = filter.q ?? 0.707;
    this.base = filter.cutoff
      * Math.pow(ctx.pitchScale, filter.keyTrack ?? 0)
      * Math.pow(2, (filter.velocity ?? 0) * ctx.velocity);
    this.env = filter.env ? new EnvelopeGenerator(filter.env, this.sr, gate) : null;
    this.amount = filter.env?.amount ?? 0;
  }
  release() {
    this.env?.release();
  }
  tick(x: number) {
    const e = this.env ? this.env.next() : 0;
    if (this.i++ % BLOCK === 0) {
      const cutoff = this.env ? this.base * Math.pow(2, this.amount * e) : this.base;
      for (let k = 0; k < this.stages.length; k++) this.stages[k].set(cutoff, this.q, this.sr);
    }
    let y = x;
    for (let k = 0; k < this.stages.length; k++) y = this.stages[k].process(y);
    return y;
  }
}

function applyFilter(filter: Filter, ctx: Context, gate: number, x: Float32Array) {
  const f = new FilterVoice(filter, ctx, gate);
  for (let i = 0; i < x.length; i++) x[i] = f.tick(x[i]);
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
