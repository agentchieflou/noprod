// Building blocks for the renderer: seeded randomness, envelopes, filters and
// band-limited wavetables.

import type { Envelope, FilterType, WaveShape } from './types.ts';

export const T60 = Math.log(1000); // e-folds in a 60 dB fall

export const midiToHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

// Per-sample multiplier that falls 60 dB in `seconds`
export const decayCoefficient = (seconds: number, sampleRate: number) =>
  seconds > 0 ? Math.exp(-T60 / (seconds * sampleRate)) : 0;

// ------------------------------------------------------------------ random

// mulberry32: small, fast and the same everywhere
export function createRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a: a stable seed from a recipe id
export function hashString(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// -------------------------------------------------------------------- sine

const SINE_SIZE = 4096;
const SINE = new Float64Array(SINE_SIZE + 1);
for (let i = 0; i <= SINE_SIZE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE);

// sin(2π·phase) for phase in cycles, from a table (error under -120 dB)
export function sine(phase: number) {
  const x = (phase - Math.floor(phase)) * SINE_SIZE;
  const i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
}

// ---------------------------------------------------------------- envelope

// Attack, hold, decay toward sustain, then release from the note-off
export class EnvelopeGenerator {
  private value = 0;
  private sample = 0;
  private readonly attack: number;
  private readonly holdEnd: number;
  private readonly sustain: number;
  private readonly decayCoef: number;
  private readonly releaseCoef: number;
  private readonly gate: number;

  constructor(env: Envelope | undefined, sampleRate: number, gateSample: number) {
    this.attack = Math.max(1, Math.round((env?.attack ?? 0.002) * sampleRate));
    this.holdEnd = this.attack + Math.round((env?.hold ?? 0) * sampleRate);
    this.sustain = env?.sustain ?? 1;
    this.decayCoef = decayCoefficient(env?.decay ?? 0, sampleRate);
    this.releaseCoef = decayCoefficient(env?.release ?? 0.05, sampleRate);
    this.gate = gateSample;
  }

  next() {
    const i = this.sample++;
    if (i >= this.gate) this.value *= this.releaseCoef;
    else if (i < this.attack) this.value = (i + 1) / this.attack;
    else if (i < this.holdEnd) this.value = 1;
    else this.value = this.sustain + (this.value - this.sustain) * this.decayCoef;
    return this.value;
  }

  // Below `floor` and staying there: released, or decayed with no sustain
  finished(floor: number) {
    return this.sample > this.holdEnd && this.value < floor && (this.sample > this.gate || this.sustain < floor);
  }
}

// How long an envelope keeps sounding after the note-off
export const releaseTime = (env: Envelope | undefined) => env?.release ?? 0.05;

// ------------------------------------------------------------------ filter

// Trapezoidal state-variable filter (Simper): stays stable and smooth while
// the cutoff moves, which a biquad doesn't
export class StateVariableFilter {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  private readonly type: FilterType;

  constructor(type: FilterType) {
    this.type = type;
  }

  set(cutoff: number, q: number, sampleRate: number) {
    const fc = Math.min(Math.max(cutoff, 5), sampleRate * 0.49);
    const g = Math.tan((Math.PI * fc) / sampleRate);
    this.k = 1 / Math.max(q, 0.05);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  process(v0: number) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    switch (this.type) {
      case 'lowpass': return v2;
      case 'highpass': return v0 - this.k * v1 - v2;
      case 'bandpass': return this.k * v1; // unity gain at the centre
      case 'notch': return v0 - this.k * v1;
    }
  }
}

// ------------------------------------------------------------------- waves

const TABLE_SIZE = 2048;
const MAX_HARMONIC = TABLE_SIZE / 2 - 1;

// One cycle per harmonic limit (1, 2, 4 … 1023 harmonics), all scaled by the
// richest table's peak so the level doesn't jump between them
export interface WaveTables {
  levels: Float32Array[];
}

const tableCache = new Map<string, WaveTables>();

// Amplitude and phase of harmonic n (1-based)
function shapeHarmonic(shape: WaveShape, n: number, width: number): [number, number] {
  switch (shape) {
    case 'sine': return [n === 1 ? 1 : 0, 0];
    case 'saw': return [(2 / Math.PI) * ((n % 2 ? 1 : -1) / n), 0];
    case 'square': return [n % 2 ? 4 / (Math.PI * n) : 0, 0];
    case 'triangle': return [n % 2 ? (8 / (Math.PI * Math.PI)) * (((n - 1) / 2) % 2 ? -1 : 1) / (n * n) : 0, 0];
    case 'pulse': return [(2 / (Math.PI * n)) * Math.sin(n * Math.PI * width), Math.PI / 2];
  }
}

export function waveTables(shape: WaveShape, width = 0.25, custom?: number[]): WaveTables {
  const key = custom ? `custom:${custom.join(',')}` : `${shape}:${shape === 'pulse' ? width : ''}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const harmonic = (n: number): [number, number] =>
    custom ? [custom[n - 1] ?? 0, 0] : shapeHarmonic(shape, n, width);
  const limit = custom ? Math.min(custom.length, MAX_HARMONIC) : MAX_HARMONIC;

  const levels: Float32Array[] = [];
  const build = (harmonics: number) => {
    const table = new Float32Array(TABLE_SIZE + 1);
    for (let n = 1; n <= harmonics; n++) {
      const [amp, phase] = harmonic(n);
      if (amp === 0) continue;
      for (let i = 0; i < TABLE_SIZE; i++) table[i] += amp * Math.sin((2 * Math.PI * n * i) / TABLE_SIZE + phase);
    }
    table[TABLE_SIZE] = table[0];
    return table;
  };
  for (let h = 1; h < limit; h *= 2) levels.push(build(h));
  levels.push(build(limit));

  const richest = levels[levels.length - 1];
  let peak = 0;
  for (let i = 0; i < TABLE_SIZE; i++) peak = Math.max(peak, Math.abs(richest[i]));
  if (peak > 0) levels.forEach((t) => { for (let i = 0; i <= TABLE_SIZE; i++) t[i] /= peak; });

  const tables = { levels };
  tableCache.set(key, tables);
  return tables;
}

// The richest table that stays below Nyquist at `hz`, or null if even the
// fundamental is past it
export function tableFor(tables: WaveTables, hz: number, sampleRate: number) {
  const harmonics = Math.floor((sampleRate * 0.475) / Math.max(hz, 1e-3));
  if (harmonics < 1) return null;
  const level = Math.min(Math.floor(Math.log2(harmonics)), tables.levels.length - 1);
  return tables.levels[level];
}

export function readTable(table: Float32Array, phase: number) {
  const x = (phase - Math.floor(phase)) * TABLE_SIZE;
  const i = x | 0;
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}
