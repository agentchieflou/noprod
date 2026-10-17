// A second-order section for the EQ kernels: the RBJ Audio EQ Cookbook's
// coefficients (the ones the Web Audio spec gives BiquadFilterNode), both
// channels' state, a block runner, its complex response for the UI's
// curves, and a flush of states that have decayed below hearing so the
// subnormal range never slows a block. Q is a plain ratio for every type
// (the native node takes it in dB for a lowpass or highpass; eq8 converts).
//
// Its settings are fields, and update() computes the coefficients from
// them: a kernel gliding a frequency writes the field and calls update()
// each sub-block, which passes no double to a call (see kernel.ts).

export type SectionType = 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass' | 'identity';

import { FLUSH } from './kernel.ts';

export class Section {
  type: SectionType = 'identity';
  freq = 1000;
  q = Math.SQRT1_2;
  gain = 0;            // dB, for a shelf or a bell
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private l1 = 0; private l2 = 0; private r1 = 0; private r2 = 0;
  // An identity section is skipped by run()
  active = false;
  private readonly sampleRate: number;

  constructor(sampleRate: number) { this.sampleRate = sampleRate; }

  set(type: SectionType, freq: number, q: number, gainDb: number) {
    this.type = type; this.freq = freq; this.q = q; this.gain = gainDb;
    this.update();
  }

  idle() { this.type = 'identity'; this.update(); }

  update() {
    const type = this.type, sampleRate = this.sampleRate;
    if (type === 'identity') { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.active = false; return; }
    const w0 = (2 * Math.PI * Math.min(Math.max(this.freq, 1), sampleRate / 2 - 1)) / sampleRate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const A = Math.pow(10, this.gain / 40);
    const Q = Math.max(this.q, 1e-4);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass': case 'highpass': {
        const alpha = sin / (2 * Q);
        const s = type === 'lowpass' ? 1 : -1;
        b0 = (1 - s * cos) / 2; b1 = s * (1 - s * cos); b2 = (1 - s * cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'notch': {
        const alpha = sin / (2 * Q);
        b0 = 1; b1 = -2 * cos; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'allpass': {
        const alpha = sin / (2 * Q);
        b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'peaking': {
        const alpha = sin / (2 * Q);
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      }
      default: { // shelves, with the fixed slope S = 1 the native node uses
        const s = type === 'lowshelf' ? 1 : -1;
        const alpha = (sin / 2) * Math.SQRT2;
        const k = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - s * (A - 1) * cos + k);
        b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cos);
        b2 = A * ((A + 1) - s * (A - 1) * cos - k);
        a0 = (A + 1) + s * (A - 1) * cos + k;
        a1 = -s * 2 * ((A - 1) + s * (A + 1) * cos);
        a2 = (A + 1) + s * (A - 1) * cos - k;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.active = true;
  }

  // Samples [from, to) of both channels, in place, direct form II transposed
  run(l: Float32Array, r: Float32Array, from: number, to: number) {
    if (!this.active) return;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
    for (let i = from; i < to; i++) {
      const x = l[i];
      const y = b0 * x + l1;
      l1 = b1 * x - a1 * y + l2;
      l2 = b2 * x - a2 * y;
      l[i] = y;
      const u = r[i];
      const v = b0 * u + r1;
      r1 = b1 * u - a1 * v + r2;
      r2 = b2 * u - a2 * v;
      r[i] = v;
    }
    this.l1 = l1 > FLUSH || l1 < -FLUSH ? l1 : 0;
    this.l2 = l2 > FLUSH || l2 < -FLUSH ? l2 : 0;
    this.r1 = r1 > FLUSH || r1 < -FLUSH ? r1 : 0;
    this.r2 = r2 > FLUSH || r2 < -FLUSH ? r2 : 0;
  }

  reset() { this.l1 = this.l2 = this.r1 = this.r2 = 0; }

  // Multiplies `acc` (re, im) by this section's response at radian frequency w
  response(w: number, acc: Float64Array) {
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    const d = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / d, hi = (ni * dr - nr * di) / d;
    const re = acc[0] * hr - acc[1] * hi;
    acc[1] = acc[0] * hi + acc[1] * hr;
    acc[0] = re;
  }

  magnitudeDb(w: number) {
    const acc = SCRATCH;
    acc[0] = 1; acc[1] = 0;
    this.response(w, acc);
    return 20 * Math.log10(Math.max(1e-6, Math.hypot(acc[0], acc[1])));
  }
}

const SCRATCH = new Float64Array(2);
