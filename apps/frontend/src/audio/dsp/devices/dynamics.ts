// The stereo-linked feed-forward compressor behind the Compressor and Glue
// Compressor kernels: the dynamics worklet's loop, ported line for line so
// a render through either is the same to the sample.
//
// Per sample: peak detect -> static gain curve with soft knee (dB) -> gain
// reduction clamped to `range` -> attack/release smoothing in the dB domain
// -> makeup -> dry/wet -> optional tanh soft clip. `release` <= 0 selects
// program-dependent auto release (Glue's "Auto"). Threshold, ratio, knee
// and range need no smoothing of their own: the envelope's attack and
// release already glide to whatever curve they set.

import { BLOCK, FLUSH, Mix, Smoothed } from './kernel.ts';

const LN10_20 = Math.LN10 / 20;

export class Dynamics {
  threshold = -18;     // dB
  ratio = 4;
  attack = 0.01;       // seconds
  release = 0.1;       // seconds; 0 is auto
  knee = 6;            // dB
  range = 100;         // dB of reduction at most
  softClip = false;
  readonly makeup: Smoothed;   // dB
  readonly mix: Mix;
  private env = 0;             // smoothed gain reduction (dB, <= 0)
  private slowEnv = 0;         // long-term reduction, drives auto release
  private readonly sampleRate: number;
  private readonly slowCoef: number;
  private readonly w = new Float32Array(BLOCK);   // the block's wet gain
  private readonly m = new Float32Array(BLOCK);   // the block's makeup, dB
  private readonly t = new Float32Array(BLOCK);   // the block's threshold

  constructor(sampleRate: number, makeupDb: number, mixPercent: number) {
    this.sampleRate = sampleRate;
    this.makeup = new Smoothed(makeupDb, sampleRate);
    this.mix = new Mix(mixPercent, sampleRate);
    this.slowCoef = Math.exp(-1 / (2 * sampleRate));
  }

  get reduction() { return this.env; }

  reset() { this.env = 0; this.slowEnv = 0; this.makeup.snap(); this.mix.wet.snap(); }

  snap() { this.makeup.snap(); this.mix.wet.snap(); }

  // Ramps are the block's lanes for Threshold, Makeup and Dry/Wet (the rest
  // of a lane's parameters are taken at the block's end, k-rate)
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number,
    rThreshold: [number, number] | undefined, rMakeup: [number, number] | undefined, rMix: [number, number] | undefined) {
    const sr = this.sampleRate;
    const { w, m, t } = this;
    const mixVaries = this.mix.fill(w, frames, rMix);
    let makeupVaries = true;
    if (rMakeup) {
      const step = (rMakeup[1] - rMakeup[0]) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) m[i] = rMakeup[0] + step * i;
      this.makeup.value = this.makeup.target = rMakeup[1];
    } else if (this.makeup.moving) {
      const mk = this.makeup;
      for (let i = 0; i < frames; i++) { mk.tick(); m[i] = mk.value; }
    } else { m[0] = this.makeup.value; makeupVaries = false; }
    let thresholdVaries = false;
    if (rThreshold) {
      const step = (rThreshold[1] - rThreshold[0]) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) t[i] = rThreshold[0] + step * i;
      this.threshold = rThreshold[1];
      thresholdVaries = true;
    } else t[0] = this.threshold;

    const ratio = Math.max(1, Math.min(100, this.ratio));
    const knee = Math.max(0, Math.min(40, this.knee));
    const range = Math.max(0, Math.min(100, this.range));
    const softClip = this.softClip;
    const attCoef = Math.exp(-1 / (Math.max(0.00001, Math.min(1, this.attack)) * sr));
    const release = Math.max(0, Math.min(5, this.release));
    const relCoefFixed = release > 0 ? Math.exp(-1 / (release * sr)) : 0;
    const slope = 1 / ratio - 1;
    const slowCoef = this.slowCoef;
    let env = this.env, slowEnv = this.slowEnv;
    let threshold = Math.max(-80, Math.min(0, t[0]));
    let makeup = Math.exp(Math.max(-24, Math.min(40, m[0])) * LN10_20);
    let mix = w[0];

    for (let i = 0; i < frames; i++) {
      if (thresholdVaries) threshold = Math.max(-80, Math.min(0, t[i]));
      if (makeupVaries) makeup = Math.exp(Math.max(-24, Math.min(40, m[i])) * LN10_20);
      if (mixVaries) mix = w[i];
      const l = inL[i], r = inR[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      const peak = al > ar ? al : ar;
      const xDb = peak > 1e-6 ? Math.log(peak) / LN10_20 : -120;

      // Static curve: target gain reduction in dB
      const over = xDb - threshold;
      let target = 0;
      if (knee > 0 && 2 * Math.abs(over) <= knee) {
        target = (slope * (over + knee / 2) * (over + knee / 2)) / (2 * knee);
      } else if (over > 0) {
        target = slope * over;
      }
      if (target < -range) target = -range;

      let relCoef = relCoefFixed;
      if (release <= 0) {
        // Auto: short release after transients, longer once reduction is sustained
        const sustained = Math.min(1, -slowEnv / 6);
        relCoef = Math.exp(-1 / ((0.08 + 1.1 * sustained) * sr));
      }
      const coef = target < env ? attCoef : relCoef;
      env = coef * env + (1 - coef) * target;
      slowEnv = slowCoef * slowEnv + (1 - slowCoef) * env;

      const g = Math.exp(env * LN10_20) * makeup;
      let yl = l * (1 - mix) + l * g * mix;
      let yr = r * (1 - mix) + r * g * mix;
      if (softClip) { yl = Math.tanh(yl); yr = Math.tanh(yr); }
      outL[i] = yl;
      outR[i] = yr;
    }
    this.env = env > FLUSH || env < -FLUSH ? env : 0;
    this.slowEnv = slowEnv > FLUSH || slowEnv < -FLUSH ? slowEnv : 0;
  }
}
