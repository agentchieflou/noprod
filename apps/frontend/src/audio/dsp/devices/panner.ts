// The strip's panner: StereoPannerNode's equal-power law for a stereo
// input, as the Web Audio spec gives it. Pan is -1 (left) to 1 (right):
// panned left, the right channel folds into the left as the right fades;
// panned right, the other way round. Smoothed so a knob never steps.

import { BLOCK, Smoothed, num, type DeviceKernel, type ParamValue } from './kernel.ts';

const HALF_PI = Math.PI / 2;

export class Panner implements DeviceKernel {
  readonly kind = 'panner';
  readonly latency = 0;
  private readonly pan: Smoothed;
  private readonly p = new Float32Array(BLOCK);
  private primed = false;

  constructor(sampleRate: number) {
    this.pan = new Smoothed(0, sampleRate);
  }

  tail() { return 0; }

  set(name: string, value: ParamValue) {
    if (name !== 'Pan') return;
    this.pan.set(Math.max(-1, Math.min(1, num(value, 0))));
    if (!this.primed) this.pan.snap();
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const ramp = ramps?.get('Pan'), pan = this.pan, p = this.p;
    if (ramp) {
      const from = Math.max(-1, Math.min(1, ramp[0])), to = Math.max(-1, Math.min(1, ramp[1])), step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) p[i] = from + step * i;
      pan.value = pan.target = to;
    } else if (pan.moving) {
      for (let i = 0; i < frames; i++) { pan.tick(); p[i] = pan.value; }
    } else {
      // One pan for the block
      const x = pan.value <= 0 ? pan.value + 1 : pan.value;
      const gl = Math.cos(x * HALF_PI), gr = Math.sin(x * HALF_PI);
      if (pan.value <= 0) {
        for (let i = 0; i < frames; i++) { const l = inL[i], r = inR[i]; outL[i] = l + r * gl; outR[i] = r * gr; }
      } else {
        for (let i = 0; i < frames; i++) { const l = inL[i], r = inR[i]; outL[i] = l * gl; outR[i] = r + l * gr; }
      }
      return;
    }
    for (let i = 0; i < frames; i++) {
      const v = p[i], l = inL[i], r = inR[i];
      const x = v <= 0 ? v + 1 : v;
      const gl = Math.cos(x * HALF_PI), gr = Math.sin(x * HALF_PI);
      if (v <= 0) { outL[i] = l + r * gl; outR[i] = r * gr; } else { outL[i] = l * gl; outR[i] = r + l * gr; }
    }
  }

  reset() { this.pan.snap(); }
}
