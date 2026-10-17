// EQ Eight: 8 bands, each a cut (12 or 48 dB/oct), a shelf, a bell or a
// notch, as the native graph builds them from biquads, plus an output gain.
// A band is up to four sections; only a 48 dB cut uses all four, and a
// band that is off, or a section it doesn't need, is skipped rather than
// run as a unity filter (the native graph runs all 32).

import { Smoothed, dbToGain, num, type DeviceKernel, type ParamValue } from './kernel.ts';
import { Section, type SectionType } from './section.ts';

export const EQ8_BANDS = 8;
const SUB = 32;                   // samples between coefficient updates while a band glides
// Q of each 2nd-order section of an 8th-order Butterworth (48 dB/oct) cut
const BUTTERWORTH_8_Q = [0.5098, 0.6013, 0.9000, 2.5629];
const DEFAULTS: { type: string; freq: number; on: boolean }[] = [
  { type: 'Low Cut 12', freq: 30, on: false },
  { type: 'Low Shelf', freq: 100, on: true },
  { type: 'Bell', freq: 250, on: true },
  { type: 'Bell', freq: 500, on: true },
  { type: 'Bell', freq: 1000, on: true },
  { type: 'Bell', freq: 2500, on: true },
  { type: 'High Shelf', freq: 6000, on: true },
  { type: 'High Cut 12', freq: 18000, on: false }
];

// Sections from `from` on sit out
const idle = (secs: Section[], from: number) => { for (let k = from; k < 4; k++) secs[k].idle(); };

interface Band {
  on: boolean;
  type: string;
  freq: Smoothed;
  gain: Smoothed;   // dB
  q: Smoothed;
  sections: Section[];
}

export class EqEight implements DeviceKernel {
  readonly kind = 'eq8';
  readonly latency = 0;
  private readonly sampleRate: number;
  private readonly bands: Band[];
  private readonly output: Smoothed;        // linear
  private outputDb = 0;
  private primed = false;
  private readonly freqNames: string[] = [];
  private readonly gainNames: string[] = [];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.bands = DEFAULTS.map((b) => ({
      on: b.on, type: b.type,
      freq: new Smoothed(b.freq, sampleRate), gain: new Smoothed(0, sampleRate), q: new Smoothed(0.71, sampleRate),
      sections: [0, 1, 2, 3].map(() => new Section(sampleRate))
    }));
    this.output = new Smoothed(1, sampleRate);
    for (let i = 0; i < EQ8_BANDS; i++) { this.freqNames.push(`${i + 1} Freq`); this.gainNames.push(`${i + 1} Gain`); }
    for (let i = 0; i < EQ8_BANDS; i++) this.configure(i);
  }

  tail() { return 0; }

  // One band's sections for its type and current (gliding) values
  private configure(i: number) {
    const b = this.bands[i], secs = b.sections, first = secs[0];
    const freq = b.freq.value, gain = b.gain.value, q = b.q.value;
    if (!b.on) { idle(secs, 0); return; }
    switch (b.type) {
      case 'Low Cut 12': case 'High Cut 12':
        first.type = b.type.startsWith('Low') ? 'highpass' : 'lowpass'; first.freq = freq; first.q = q; first.gain = 0;
        first.update();
        idle(secs, 1);
        break;
      case 'Low Cut 48': case 'High Cut 48': {
        const type: SectionType = b.type.startsWith('Low') ? 'highpass' : 'lowpass';
        // resonance scales the sharpest section; the rest stay Butterworth
        for (let k = 0; k < 4; k++) {
          const s = secs[k];
          s.type = type; s.freq = freq; s.q = k === 3 ? BUTTERWORTH_8_Q[k] * (q / 0.71) : BUTTERWORTH_8_Q[k]; s.gain = 0;
          s.update();
        }
        break;
      }
      case 'Low Shelf': case 'High Shelf':
        first.type = b.type === 'Low Shelf' ? 'lowshelf' : 'highshelf'; first.freq = freq; first.q = q; first.gain = gain;
        first.update();
        idle(secs, 1);
        break;
      case 'Notch':
        first.type = 'notch'; first.freq = freq; first.q = q; first.gain = 0;
        first.update();
        idle(secs, 1);
        break;
      default: // Bell
        first.type = 'peaking'; first.freq = freq; first.q = q; first.gain = gain;
        first.update();
        idle(secs, 1);
    }
  }

  set(name: string, value: ParamValue) {
    if (name === 'Output') {
      this.outputDb = num(value, 0);
      this.output.set(dbToGain(this.outputDb));
      if (!this.primed) this.output.snap();
      return;
    }
    const i = parseInt(name) - 1;
    if (!(i >= 0 && i < EQ8_BANDS)) return;
    const b = this.bands[i];
    const field = name.slice(name.indexOf(' ') + 1);
    switch (field) {
      case 'On': b.on = value === true; break;
      case 'Type': b.type = String(value); break;
      case 'Freq': b.freq.set(num(value, b.freq.target)); if (!this.primed) b.freq.snap(); break;
      case 'Gain': b.gain.set(num(value, b.gain.target)); if (!this.primed) b.gain.snap(); break;
      case 'Q': b.q.set(num(value, b.q.target)); if (!this.primed) b.q.snap(); break;
      default: return;
    }
    this.configure(i);
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    if (outL !== inL) for (let i = 0; i < frames; i++) { outL[i] = inL[i]; outR[i] = inR[i]; }
    const bands = this.bands;
    for (let i = 0; i < frames; i += SUB) {
      const to = Math.min(frames, i + SUB);
      for (let k = 0; k < EQ8_BANDS; k++) {
        const b = bands[k];
        if (!b.on) continue;
        const rf = ramps?.get(this.freqNames[k]), rg = ramps?.get(this.gainNames[k]);
        if (rf || rg || b.freq.moving || b.gain.moving || b.q.moving) {
          if (rf) b.freq.value = b.freq.target = rf[0] + ((rf[1] - rf[0]) / Math.max(1, frames - 1)) * i;
          if (rg) b.gain.value = b.gain.target = rg[0] + ((rg[1] - rg[0]) / Math.max(1, frames - 1)) * i;
          this.configure(k);
          b.freq.skip(to - i); b.gain.skip(to - i); b.q.skip(to - i);
        }
        const secs = b.sections;
        secs[0].run(outL, outR, i, to); secs[1].run(outL, outR, i, to); secs[2].run(outL, outR, i, to); secs[3].run(outL, outR, i, to);
      }
    }
    for (let k = 0; k < EQ8_BANDS; k++) {
      const b = bands[k];
      const rf = ramps?.get(this.freqNames[k]), rg = ramps?.get(this.gainNames[k]);
      if (rf) b.freq.value = b.freq.target = rf[1];
      if (rg) b.gain.value = b.gain.target = rg[1];
    }
    // Output gain: a ramp, a glide, or one value
    const ro = ramps?.get('Output'), out = this.output;
    if (ro) {
      const from = Math.pow(10, ro[0] / 20), to = Math.pow(10, ro[1] / 20), step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) { const g = from + step * i; outL[i] *= g; outR[i] *= g; }
      this.outputDb = ro[1];
      out.value = out.target = to;
    } else if (out.moving) {
      for (let i = 0; i < frames; i++) { out.tick(); const g = out.value; outL[i] *= g; outR[i] *= g; }
    } else if (out.value !== 1) {
      const g = out.value;
      for (let i = 0; i < frames; i++) { outL[i] *= g; outR[i] *= g; }
    }
  }

  reset() {
    for (let k = 0; k < EQ8_BANDS; k++) {
      const b = this.bands[k];
      b.freq.snap(); b.gain.snap(); b.q.snap();
      for (const s of b.sections) s.reset();
      this.configure(k);
    }
    this.output.snap();
  }

  // The sections' magnitudes summed in dB, plus the output gain
  response(freqs: Float32Array): Float32Array {
    const out = new Float32Array(freqs.length).fill(20 * Math.log10(Math.max(1e-6, this.output.target)));
    for (const b of this.bands) {
      if (!b.on) continue;
      for (const s of b.sections) {
        if (!s.active) continue;
        for (let i = 0; i < freqs.length; i++) out[i] += s.magnitudeDb((2 * Math.PI * freqs[i]) / this.sampleRate);
      }
    }
    return out;
  }
}
