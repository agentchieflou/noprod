// The voices the engine worklet plays, each a sample at a time from the
// frame it starts on: a rendered note or sample from a buffer, the NoProd
// Synth's oscillator and ADSR, and a NoProd Drums hit, as synth.ts and
// library.ts built them from nodes. Nothing here allocates while rendering.
//
// A voice renders its part of a block with render(l, r, from, to, frame):
// samples [from, to) of the block that starts at `frame`, so a note that
// starts mid-block starts on its sample. release(at) is a key let go,
// stop(at) a cut (a few milliseconds' fade), both at a frame.

import { createRandom, readTable, tableFor, waveTables, type WaveShape } from '@noprod/sound';
import { Biquad, type BiquadType } from './biquad.ts';
import type { VoiceSpec } from './events.ts';

export interface Buf { l: Float32Array; r: Float32Array }

export interface Voice {
  readonly key: string;
  readonly start: number;    // frame
  done: boolean;
  render(l: Float32Array, r: Float32Array, from: number, to: number, frame: number): void;
  release(at: number): void;
  stop(at: number): void;
}

const CUT = 0.005;           // seconds: a stopped voice fades this fast
const CHOKE = 0.008;         // a choked drum, as library.ts faded it
const SILENT = 1e-5;

// A gain that approaches a target exponentially, as setTargetAtTime does
class Fade {
  value = 1;
  private target = 1;
  private coef = 0;
  private at = Infinity;     // frame the move starts
  private to = 0;
  private tau = 0;
  private sampleRate: number;
  constructor(sampleRate: number) { this.sampleRate = sampleRate; }
  // Move to `to` from frame `at` with time constant `tau` seconds
  set(at: number, to: number, tau: number) {
    if (at < this.at || this.at === Infinity) { this.at = at; this.to = to; this.tau = tau; }
  }
  get moving() { return this.at !== Infinity; }
  // The gain at absolute frame `f` (call once per sample, in order)
  step(f: number): number {
    if (f >= this.at && this.target !== this.to) {
      this.target = this.to;
      this.coef = Math.exp(-1 / (this.tau * this.sampleRate));
    }
    if (this.target !== this.value) this.value = this.target + (this.value - this.target) * this.coef;
    return this.value;
  }
}

// ----------------------------------------------------------------- buffer

export class BufferVoice implements Voice {
  done = false;
  private pos = 0;           // source frames read
  private readonly fade: Fade;
  private readonly length: number;
  private endAt = Infinity;  // frame to stop at (after a fade)
  readonly chokeGroup: number;
  readonly pad: number;

  readonly key: string;
  readonly start: number;
  private buf: Buf;
  private rate: number;
  private level: number;
  private releaseTime: number | undefined;

  constructor(key: string, start: number, buf: Buf, rate: number, level: number,
    releaseTime: number | undefined, choke: { group: number; pad: number } | undefined, sampleRate: number) {
    this.key = key;
    this.start = start;
    this.buf = buf;
    this.rate = rate;
    this.level = level;
    this.releaseTime = releaseTime;
    this.fade = new Fade(sampleRate);
    this.length = buf.l.length;
    this.chokeGroup = choke?.group ?? -1;
    this.pad = choke?.pad ?? -1;
    this.sr = sampleRate;
  }
  private sr: number;

  render(l: Float32Array, r: Float32Array, from: number, to: number, frame: number) {
    const { l: bl, r: br } = this.buf;
    const level = this.level, rate = this.rate, fade = this.fade;
    let pos = this.pos;
    for (let i = from; i < to; i++) {
      const f = frame + i;
      if (f >= this.endAt) { this.done = true; break; }
      const g = fade.moving ? fade.step(f) * level : level;
      if (rate === 1) {
        const k = pos | 0;
        if (k >= this.length) { this.done = true; break; }
        l[i] += bl[k] * g;
        r[i] += br[k] * g;
        pos += 1;
      } else {
        const k = pos | 0;
        if (k + 1 >= this.length) { this.done = true; break; }
        const t = pos - k;
        l[i] += (bl[k] + (bl[k + 1] - bl[k]) * t) * g;
        r[i] += (br[k] + (br[k + 1] - br[k]) * t) * g;
        pos += rate;
      }
      if (fade.moving && fade.value < SILENT && f >= this.endAt - 1e9) { this.done = true; break; }
    }
    this.pos = pos;
  }

  // Let go: a held note fades with its sound's release; a one-shot plays out
  release(at: number) {
    if (this.releaseTime === undefined) return;
    this.fade.set(at, 0, this.releaseTime / 6.9);
    this.endAt = Math.min(this.endAt, at + Math.round(this.releaseTime * this.sr));
  }

  stop(at: number) {
    this.fade.set(at, 0, CUT);
    this.endAt = Math.min(this.endAt, at + Math.round(CUT * 8 * this.sr));
  }

  choke(at: number) {
    this.fade.set(at, 0, CHOKE);
    this.endAt = Math.min(this.endAt, at + Math.round(0.06 * this.sr));
  }
}

// ------------------------------------------------------------------ synth

const SHAPES: Record<string, WaveShape> = { sine: 'sine', square: 'square', sawtooth: 'saw', triangle: 'triangle' };

// A piecewise-linear envelope: a list of (frame, value) corners, in order
class Lines {
  private corners: { at: number; value: number }[] = [];
  value = 0;
  private slope = 0;
  private next = 0;          // index of the corner being approached
  from(at: number, value: number) { this.corners = [{ at, value }]; this.next = 0; return this; }
  to(at: number, value: number) { this.corners.push({ at, value }); return this; }
  // Cut the envelope at frame `at`: from its value then, a line to 0 over `seconds`
  cut(at: number, seconds: number, sampleRate: number) {
    const v = this.at(at);
    this.corners = this.corners.filter((c) => c.at < at);
    this.corners.push({ at, value: v }, { at: at + Math.max(1, Math.round(seconds * sampleRate)), value: 0 });
    this.next = Math.max(0, this.corners.length - 2);
    this.slope = 0;
  }
  // The envelope's value at a frame, from its corners
  at(f: number): number {
    const c = this.corners;
    if (!c.length || f <= c[0].at) return c[0]?.value ?? 0;
    for (let i = 1; i < c.length; i++) {
      if (f < c[i].at) return c[i - 1].value + ((f - c[i - 1].at) / (c[i].at - c[i - 1].at)) * (c[i].value - c[i - 1].value);
    }
    return c[c.length - 1].value;
  }
  get end() { return this.corners[this.corners.length - 1]?.at ?? 0; }
  // Advance one sample to frame `f`
  step(f: number): number {
    const c = this.corners;
    while (this.next < c.length && f >= c[this.next].at) {
      this.value = c[this.next].value;
      this.next++;
      this.slope = this.next < c.length ? (c[this.next].value - this.value) / Math.max(1, c[this.next].at - c[this.next - 1].at) : 0;
    }
    if (this.next < c.length && f > c[this.next - 1]?.at) this.value += this.slope;
    return this.value;
  }
}

export class SynthVoice implements Voice {
  done = false;
  private phase = 0;
  private readonly table: Float32Array | null;
  private readonly step: number;
  private readonly env = new Lines();
  private released = false;

  readonly key: string;
  readonly start: number;
  private sampleRate: number;

  constructor(key: string, start: number, spec: Extract<VoiceSpec, { kind: 'synth' }>, duration: number | null, sampleRate: number) {
    this.key = key;
    this.start = start;
    this.sampleRate = sampleRate;
    this.table = tableFor(waveTables(SHAPES[spec.wave] ?? 'saw'), spec.hz, sampleRate);
    this.step = spec.hz / sampleRate;
    const fr = (s: number) => Math.round(s * sampleRate);
    const { attack, decay, sustain, release, peak } = spec;
    this.release_ = release;
    this.env.from(start, 0).to(start + fr(attack), peak).to(start + fr(attack + decay), peak * sustain);
    if (duration !== null) {
      // a scheduled note: held for its duration (at least through attack and decay), then released
      const holdEnd = start + Math.max(fr(attack + decay), fr(duration));
      this.env.to(holdEnd, peak * sustain).to(holdEnd + fr(release), 0);
      this.endAt = holdEnd + fr(release) + fr(0.05);
    }
  }
  private release_: number;
  private endAt = Infinity;

  render(l: Float32Array, r: Float32Array, from: number, to: number, frame: number) {
    const table = this.table;
    for (let i = from; i < to; i++) {
      const f = frame + i;
      if (f >= this.endAt) { this.done = true; break; }
      const g = this.env.step(f);
      if (table) {
        const v = readTable(table, this.phase) * g;
        l[i] += v; r[i] += v;
      }
      this.phase += this.step;
      if (this.phase >= 1) this.phase -= 1;
    }
  }

  // Let go: hold whatever level the envelope reached, then fade over the release
  release(at: number) {
    if (this.released) return;
    this.released = true;
    this.env.cut(at, this.release_, this.sampleRate);
    this.endAt = Math.min(this.endAt, this.env.end + Math.round(0.05 * this.sampleRate));
  }

  stop(at: number) {
    this.released = true;
    this.env.cut(at, CUT, this.sampleRate);
    this.endAt = Math.min(this.endAt, this.env.end + 1);
  }
}

// ------------------------------------------------------------------ drums

// One part of a hit: a swept tone or filtered noise, with the kit's envelope
// (2 ms up, then an exponential fall to -80 dB over its length, scaled by Decay)
interface Part {
  at: number;                // frame it starts
  end: number;               // frame it stops
  peak: number;
  fallEnd: number;           // frame the fall reaches -80 dB
  tone: { table: Float32Array | null; f0: number; ratio: number; sweep: number; phase: number } | null;
  noise: { filter: Biquad } | null;
}

export class DrumVoice implements Voice {
  done = false;
  private parts: Part[] = [];
  private readonly random: () => number;
  private readonly fade: Fade;
  private endAt = Infinity;
  private cut = false;

  readonly key: string;
  readonly start: number;
  private sampleRate: number;

  constructor(key: string, start: number, spec: Extract<VoiceSpec, { kind: 'drum' }>, sampleRate: number, seed: number) {
    this.key = key;
    this.start = start;
    this.sampleRate = sampleRate;
    this.random = createRandom(seed);
    this.fade = new Fade(sampleRate);
    const decay = spec.decay;
    const tune = Math.pow(2, spec.tune / 12);
    const level = spec.level;
    const fr = (s: number) => Math.round(s * sampleRate);
    const part = (len: number, peak: number, offset: number, tone: Part['tone'], noise: Part['noise']) => {
      const at = start + fr(offset);
      this.parts.push({ at, end: at + fr(len * decay + 0.05), peak: peak * level, fallEnd: at + fr(Math.max(0.01, len * decay)), tone, noise });
    };
    const tone = (shape: WaveShape, f0: number, f1: number, sweep: number, len: number, peak = 1) =>
      part(len, peak, 0, { table: tableFor(waveTables(shape), f0 * tune, sampleRate), f0: f0 * tune, ratio: f1 / f0, sweep, phase: 0 }, null);
    const noise = (len: number, type: BiquadType, freq: number, q = 0.7, peak = 1, offset = 0) => {
      const filter = new Biquad();
      filter.set(type, freq, q, 0, sampleRate);
      part(len, peak, offset, null, { filter });
    };
    switch (spec.note) {
      case 35: case 36: tone('sine', 150, 45, 0.12, 0.45, 1.2); break;
      case 38: case 40: tone('triangle', 190, 160, 0.05, 0.12, 0.6); noise(0.2, 'bandpass', 1900, 0.8, 0.9); break;
      case 39: [0, 0.012, 0.026].forEach((d) => noise(0.08, 'bandpass', 1200, 1.2, 0.7, d)); noise(0.25, 'bandpass', 1200, 1.2, 0.6, 0.04); break;
      case 42: case 44: noise(0.05, 'highpass', 7500, 0.7, 0.5); break;
      case 46: noise(0.35, 'highpass', 7000, 0.7, 0.45); break;
      case 49: case 57: noise(1.4, 'highpass', 5000, 0.7, 0.4); break;
      default: {
        const f = 440 * Math.pow(2, (spec.note - 69) / 12);
        tone('sine', f * 1.6, f, 0.08, 0.35, 0.9);
      }
    }
    this.endAt = Math.max(...this.parts.map((p) => p.end));
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number, frame: number) {
    const sr = this.sampleRate;
    const up = Math.round(0.002 * sr);
    for (let i = from; i < to; i++) {
      const f = frame + i;
      if (f >= this.endAt) { this.done = true; break; }
      let v = 0;
      for (let k = 0; k < this.parts.length; k++) {
        const p = this.parts[k];
        if (f < p.at || f >= p.end) continue;
        const t = f - p.at;
        // the envelope: linear to the peak over 2 ms, then (1e-4 / peak)^(t / fall)
        const g = t < up ? (p.peak * t) / up : p.peak * Math.pow(1e-4 / p.peak, Math.min(1, (t - up) / Math.max(1, p.fallEnd - p.at - up)));
        if (p.tone) {
          const tn = p.tone;
          const sweep = Math.min(1, t / (tn.sweep * sr));
          const hz = tn.f0 * Math.pow(tn.ratio, sweep);
          if (tn.table) v += readTable(tn.table, tn.phase) * g;
          tn.phase += hz / sr;
          if (tn.phase >= 1) tn.phase -= 1;
        } else if (p.noise) {
          v += p.noise.filter.tick(this.random() * 2 - 1) * g;
        }
      }
      if (this.cut) v *= this.fade.step(f);
      l[i] += v; r[i] += v;
    }
  }

  // Drum hits are one-shots: nothing to release
  release() {}

  stop(at: number) {
    this.cut = true;
    this.fade.set(at, 0, CUT);
    this.endAt = Math.min(this.endAt, at + Math.round(CUT * 8 * this.sampleRate));
  }
}

// A key's voice spec as a Voice, started at `start`; null for a model (liveVoices.ts)
export function makeVoice(key: string, start: number, spec: VoiceSpec, duration: number | null, bufs: Map<number, Buf>, sampleRate: number, seed: number): Voice | null {
  switch (spec.kind) {
    case 'buffer': {
      const buf = bufs.get(spec.buf);
      return buf ? new BufferVoice(key, start, buf, spec.rate, spec.level, spec.release, spec.choke, sampleRate) : null;
    }
    case 'synth': return new SynthVoice(key, start, spec, duration, sampleRate);
    case 'drum': return new DrumVoice(key, start, spec, sampleRate, seed);
    default: return null;
  }
}
