// DSP shared by the spike's worklets (#159 design): a buffer-playing voice
// queue, biquad sections as the Web Audio spec defines them, a port of the
// dynamics processor's per-sample loop, and a feedback-delay-network reverb.
// Every block of 128 frames allocates nothing.

export const BLOCK = 128;

export interface Buf { l: Float32Array; r: Float32Array }

export interface NoteEvent { buf: number; at: number; gain: number } // at: audio time, seconds

interface Voice { buf: Buf; start: number; gain: number }           // start: absolute frame

// Notes queued ahead of time and played sample-accurately from their buffers
export class VoiceQueue {
  private buffers = new Map<number, Buf>();
  private pending: { frame: number; buf: number; gain: number }[] = [];
  private voices: Voice[] = [];
  late = 0;         // events that arrived after their time
  worstLate = 0;    // frames
  played = 0;

  constructor(private sampleRate: number, private maxVoices = 64) {}

  addBuffer(id: number, buf: Buf) { this.buffers.set(id, buf); }

  // `now` is the frame the next block starts at
  add(e: NoteEvent, now: number) {
    const frame = Math.round(e.at * this.sampleRate);
    if (frame < now) { this.late++; this.worstLate = Math.max(this.worstLate, now - frame); }
    this.pending.push({ frame: Math.max(frame, now), buf: e.buf, gain: e.gain });
  }

  // Which events start at or after frame `from` are dropped (an edit ahead of the horizon)
  retractFrom(from: number) { this.pending = this.pending.filter((p) => p.frame < from); }

  get sounding() { return this.voices.length; }

  // Mix every voice sounding in [frame, frame + BLOCK) into l/r
  render(frame: number, l: Float32Array, r: Float32Array) {
    const end = frame + BLOCK;
    if (this.pending.length) {
      const keep: typeof this.pending = [];
      for (const p of this.pending) {
        if (p.frame >= end) { keep.push(p); continue; }
        const buf = this.buffers.get(p.buf);
        if (!buf) continue;
        if (this.voices.length >= this.maxVoices) this.voices.shift();
        this.voices.push({ buf, start: p.frame, gain: p.gain });
        this.played++;
      }
      this.pending = keep;
    }
    let w = 0;
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v];
      const { l: bl, r: br } = voice.buf;
      const len = bl.length;
      const first = Math.max(0, voice.start - frame);
      const g = voice.gain;
      let i = voice.start > frame ? 0 : frame - voice.start;
      for (let k = first; k < BLOCK && i < len; k++, i++) {
        l[k] += bl[i] * g;
        r[k] += br[i] * g;
      }
      if (i < len) this.voices[w++] = voice; // still sounding
    }
    this.voices.length = w;
  }
}

// ------------------------------------------------------------------ biquad

export type BiquadType = 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'notch';

// One second-order section (direct form II transposed), coefficients from
// the Web Audio spec's BiquadFilterNode formulas
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0; private z2 = 0;

  set(type: BiquadType, freq: number, q: number, gainDb: number, sampleRate: number) {
    const w0 = 2 * Math.PI * Math.min(freq, sampleRate / 2 - 1) / sampleRate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'peaking': {
        const alpha = sin / (2 * q);
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      }
      case 'lowshelf': case 'highshelf': {
        const s = type === 'lowshelf' ? 1 : -1;
        const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
        const k = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - s * (A - 1) * cos + k);
        b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cos);
        b2 = A * ((A + 1) - s * (A - 1) * cos - k);
        a0 = (A + 1) + s * (A - 1) * cos + k;
        a1 = -s * 2 * ((A - 1) + s * (A + 1) * cos);
        a2 = (A + 1) + s * (A - 1) * cos - k;
        break;
      }
      case 'lowpass': case 'highpass': {
        const alpha = sin / (2 * q);
        const s = type === 'lowpass' ? 1 : -1;
        b0 = (1 - s * cos) / 2; b1 = s * (1 - s * cos); b2 = (1 - s * cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      default: { // notch
        const alpha = sin / (2 * q);
        b0 = 1; b1 = -2 * cos; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  process(x: Float32Array) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1, z2 = this.z2;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }
}

// EQ Eight as the app configures it by default: 8 bands of 4 sections, 32
// biquads in all, the unused ones unity peaking filters (as in devices.ts)
export class EqEight {
  private left: Biquad[] = [];
  private right: Biquad[] = [];
  constructor(sampleRate: number) {
    const defaults: [BiquadType, number][] = [
      ['peaking', 30], ['lowshelf', 100], ['peaking', 250], ['peaking', 500],
      ['peaking', 1000], ['peaking', 2500], ['highshelf', 6000], ['peaking', 18000]
    ];
    for (const [type, freq] of defaults) {
      for (let k = 0; k < 4; k++) {
        for (const side of [this.left, this.right]) {
          const b = new Biquad();
          b.set(k === 0 ? type : 'peaking', freq, 0.71, 0, sampleRate);
          side.push(b);
        }
      }
    }
  }
  process(l: Float32Array, r: Float32Array) {
    for (let i = 0; i < this.left.length; i++) { this.left[i].process(l); this.right[i].process(r); }
  }
}

// -------------------------------------------------------------- compressor

// The dynamics processor's loop (worklets/dynamics-processor.js) with the
// Compressor device's defaults: stereo-linked, soft knee, smoothed in dB
export class Compressor {
  private env = 0;
  private readonly attCoef: number;
  private readonly relCoef: number;
  constructor(sampleRate: number, private threshold = -18, ratio = 4, attack = 0.01, release = 0.1, private knee = 6) {
    this.attCoef = Math.exp(-1 / (attack * sampleRate));
    this.relCoef = Math.exp(-1 / (release * sampleRate));
    this.slope = 1 / ratio - 1;
  }
  private slope: number;
  process(l: Float32Array, r: Float32Array) {
    const { threshold, knee, slope, attCoef, relCoef } = this;
    let env = this.env;
    for (let i = 0; i < l.length; i++) {
      const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      const xDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
      const over = xDb - threshold;
      let target = 0;
      if (knee > 0 && 2 * Math.abs(over) <= knee) target = (slope * (over + knee / 2) * (over + knee / 2)) / (2 * knee);
      else if (over > 0) target = slope * over;
      const coef = target < env ? attCoef : relCoef;
      env = coef * env + (1 - coef) * target;
      const g = Math.pow(10, env / 20);
      l[i] *= g; r[i] *= g;
    }
    this.env = env;
  }
}

// ------------------------------------------------------------------ reverb

// An 8-line feedback delay network with a Householder feedback matrix and
// one-pole damping in each line: the algorithmic reverb an engine of our own
// would use in place of a 2.5 s convolution
export class FdnReverb {
  private static LENGTHS = [1051, 1327, 1559, 1801, 2111, 2399, 2707, 3001]; // primes, 24-68 ms at 44.1k
  private lines: Float32Array[];
  private heads: number[];
  private gains: number[];
  private lp: number[];
  private damp = 0.3;
  private out = new Float64Array(8);
  constructor(sampleRate: number, decay = 2.5, private wet = 0.3) {
    this.lines = FdnReverb.LENGTHS.map((n) => new Float32Array(Math.round(n * sampleRate / 44100)));
    this.heads = this.lines.map(() => 0);
    this.gains = this.lines.map((line) => Math.pow(10, -3 * line.length / (decay * sampleRate)));
    this.lp = this.lines.map(() => 0);
  }
  process(l: Float32Array, r: Float32Array) {
    const { lines, heads, gains, lp, out, wet, damp } = this;
    const dry = 1 - wet;
    const n = lines.length;
    for (let i = 0; i < l.length; i++) {
      const input = (l[i] + r[i]) * 0.5;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const v = lines[k][heads[k]];
        lp[k] += damp * (v - lp[k]);
        out[k] = lp[k] * gains[k];
        sum += out[k];
      }
      const h = sum * (2 / n); // Householder: y = x - (2/N) * sum(x)
      let wl = 0, wr = 0;
      for (let k = 0; k < n; k++) {
        const fb = out[k] - h + input;
        lines[k][heads[k]] = fb;
        heads[k] = heads[k] + 1 === lines[k].length ? 0 : heads[k] + 1;
        if (k & 1) wr += out[k]; else wl += out[k];
      }
      l[i] = l[i] * dry + wl * wet;
      r[i] = r[i] * dry + wr * wet;
    }
  }
}

// -------------------------------------------------------------- limiter

// The master's brickwall, as masterLimiter configures the native node
export class Limiter extends Compressor {
  constructor(sampleRate: number) { super(sampleRate, -1, 20, 0.001, 0.1, 0); }
}
