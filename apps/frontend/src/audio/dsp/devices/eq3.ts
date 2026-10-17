// EQ Three: a 3-band DJ EQ on a Linkwitz-Riley 4th-order crossover, as the
// native graph builds it from Butterworth biquads. The low band gets an
// allpass at the high crossover so the three bands stay phase-matched and
// sum flat with every gain at 0 dB. Per channel: 9 sections a sample.

import { BLOCK, Smoothed, dbToGain, num, type DeviceKernel, type ParamValue } from './kernel.ts';
import { Section } from './section.ts';

const SUB = 32;                   // samples between coefficient updates while a frequency glides
const Q = Math.SQRT1_2;           // Butterworth

export class EqThree implements DeviceKernel {
  readonly kind = 'eq3';
  readonly latency = 0;
  private readonly sampleRate: number;
  private readonly lowLp: Section[];
  private readonly lowAp: Section;
  private readonly splitHp: Section[];
  private readonly midLp: Section[];
  private readonly highHp: Section[];
  private readonly freqLo: Smoothed;
  private readonly freqHi: Smoothed;
  private readonly gains: Smoothed[];       // linear, lo mid hi
  private readonly gainDb = [0, 0, 0];
  private readonly kills = [false, false, false];
  private primed = false;
  // the bands, split off the input
  private readonly loL = new Float32Array(BLOCK); private readonly loR = new Float32Array(BLOCK);
  private readonly hiL = new Float32Array(BLOCK); private readonly hiR = new Float32Array(BLOCK);
  private readonly g = [new Float32Array(BLOCK), new Float32Array(BLOCK), new Float32Array(BLOCK)];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const pair = (type: 'lowpass' | 'highpass') => [0, 1].map(() => { const s = new Section(sampleRate); s.type = type; s.q = Q; return s; });
    this.lowLp = pair('lowpass'); this.splitHp = pair('highpass'); this.midLp = pair('lowpass'); this.highHp = pair('highpass');
    this.lowAp = new Section(sampleRate); this.lowAp.type = 'allpass'; this.lowAp.q = Q;
    this.freqLo = new Smoothed(250, sampleRate);
    this.freqHi = new Smoothed(2500, sampleRate);
    this.gains = [0, 1, 2].map(() => new Smoothed(1, sampleRate));
    this.coefficients();
  }

  tail() { return 0; }

  private coefficients() {
    const fl = this.freqLo.value, fh = this.freqHi.value;
    for (let i = 0; i < 2; i++) {
      this.lowLp[i].freq = fl; this.lowLp[i].update();
      this.splitHp[i].freq = fl; this.splitHp[i].update();
      this.midLp[i].freq = fh; this.midLp[i].update();
      this.highHp[i].freq = fh; this.highHp[i].update();
    }
    this.lowAp.freq = fh; this.lowAp.update();
  }

  private sections() { return [...this.lowLp, this.lowAp, ...this.splitHp, ...this.midLp, ...this.highHp]; }

  private bandGain(i: number) { return this.kills[i] ? 0 : dbToGain(this.gainDb[i], -48); }

  set(name: string, value: ParamValue) {
    const band = name === 'GainLo' || name === 'Kill Lo' ? 0 : name === 'GainMid' || name === 'Kill Mid' ? 1 : name === 'GainHi' || name === 'Kill Hi' ? 2 : -1;
    if (band >= 0) {
      if (name.startsWith('Kill')) this.kills[band] = value === true;
      else this.gainDb[band] = num(value, 0);
      this.gains[band].set(this.bandGain(band));
      if (!this.primed) this.gains[band].snap();
      return;
    }
    const f = name === 'FreqLo' ? this.freqLo : name === 'FreqHi' ? this.freqHi : null;
    if (!f) return;
    f.set(num(value, f.target));
    if (!this.primed) { f.snap(); this.coefficients(); }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const { loL, loR, hiL, hiR, g } = this;
    // The band gains per sample: a ramp, a glide, or one value
    const rLo = ramps?.get('GainLo'), rMid = ramps?.get('GainMid'), rHi = ramps?.get('GainHi');
    this.fillGain(0, rLo, frames); this.fillGain(1, rMid, frames); this.fillGain(2, rHi, frames);
    const rFl = ramps?.get('FreqLo'), rFh = ramps?.get('FreqHi');
    // outL/outR hold the mid band on the way (in place is allowed: the low
    // band's copy is made first)
    for (let i = 0; i < frames; i++) { loL[i] = inL[i]; loR[i] = inR[i]; outL[i] = inL[i]; outR[i] = inR[i]; }
    for (let i = 0; i < frames; i += SUB) {
      const to = Math.min(frames, i + SUB);
      if (rFl || rFh || this.freqLo.moving || this.freqHi.moving) {
        if (rFl) this.freqLo.value = this.freqLo.target = rFl[0] + ((rFl[1] - rFl[0]) / Math.max(1, frames - 1)) * i;
        if (rFh) this.freqHi.value = this.freqHi.target = rFh[0] + ((rFh[1] - rFh[0]) / Math.max(1, frames - 1)) * i;
        this.coefficients();
        this.freqLo.skip(to - i); this.freqHi.skip(to - i);
      }
      this.lowLp[0].run(loL, loR, i, to); this.lowLp[1].run(loL, loR, i, to);
      this.lowAp.run(loL, loR, i, to);
      this.splitHp[0].run(outL, outR, i, to); this.splitHp[1].run(outL, outR, i, to);
      for (let k = i; k < to; k++) { hiL[k] = outL[k]; hiR[k] = outR[k]; }
      this.midLp[0].run(outL, outR, i, to); this.midLp[1].run(outL, outR, i, to);
      this.highHp[0].run(hiL, hiR, i, to); this.highHp[1].run(hiL, hiR, i, to);
    }
    if (rFl) this.freqLo.value = this.freqLo.target = rFl[1];
    if (rFh) this.freqHi.value = this.freqHi.target = rFh[1];
    const gl = g[0], gm = g[1], gh = g[2];
    for (let i = 0; i < frames; i++) {
      outL[i] = loL[i] * gl[i] + outL[i] * gm[i] + hiL[i] * gh[i];
      outR[i] = loR[i] * gl[i] + outR[i] * gm[i] + hiR[i] * gh[i];
    }
  }

  private fillGain(band: number, ramp: [number, number] | undefined, frames: number) {
    const g = this.g[band], s = this.gains[band];
    if (ramp) {
      const killed = this.kills[band];
      const from = killed || ramp[0] <= -48 ? 0 : Math.pow(10, ramp[0] / 20);
      const to = killed || ramp[1] <= -48 ? 0 : Math.pow(10, ramp[1] / 20);
      const step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) g[i] = from + step * i;
      this.gainDb[band] = ramp[1];
      s.value = s.target = to;
    } else if (s.moving) {
      for (let i = 0; i < frames; i++) { s.tick(); g[i] = s.value; }
    } else {
      const v = s.value;    // a loop, not fill(): a double handed to a builtin is boxed
      for (let i = 0; i < frames; i++) g[i] = v;
    }
  }

  reset() {
    for (const s of this.sections()) s.reset();
    this.freqLo.snap(); this.freqHi.snap();
    for (const g of this.gains) g.snap();
    this.coefficients();
  }

  // The bands' complex responses summed with their gains, in dB
  response(freqs: Float32Array): Float32Array {
    const out = new Float32Array(freqs.length);
    const lo = new Float64Array(2), split = new Float64Array(2), mid = new Float64Array(2), hi = new Float64Array(2);
    const gl = this.gains[0].target, gm = this.gains[1].target, gh = this.gains[2].target;
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * freqs[i]) / this.sampleRate;
      lo[0] = 1; lo[1] = 0; split[0] = 1; split[1] = 0;
      for (const s of this.lowLp) s.response(w, lo);
      this.lowAp.response(w, lo);
      for (const s of this.splitHp) s.response(w, split);
      mid[0] = split[0]; mid[1] = split[1]; hi[0] = split[0]; hi[1] = split[1];
      for (const s of this.midLp) s.response(w, mid);
      for (const s of this.highHp) s.response(w, hi);
      const re = lo[0] * gl + mid[0] * gm + hi[0] * gh, im = lo[1] * gl + mid[1] * gm + hi[1] * gh;
      out[i] = 20 * Math.log10(Math.max(1e-6, Math.hypot(re, im)));
    }
    return out;
  }
}
