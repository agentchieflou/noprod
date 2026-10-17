// Compressor: the dynamics loop with its knobs in the ParamSpec's units
// (Threshold dB, Ratio, Attack and Release ms, Knee dB, Makeup dB, Dry/Wet %).

import { num, type DeviceKernel, type ParamValue } from './kernel.ts';
import { Dynamics } from './dynamics.ts';

export class Compressor implements DeviceKernel {
  readonly kind = 'compressor';
  readonly latency = 0;
  private readonly dyn: Dynamics;
  private primed = false;

  constructor(sampleRate: number) {
    this.dyn = new Dynamics(sampleRate, 0, 100);
  }

  tail() { return 0; }

  set(name: string, value: ParamValue) {
    const d = this.dyn;
    switch (name) {
      case 'Threshold': d.threshold = num(value, -18); break;
      case 'Ratio': d.ratio = num(value, 4); break;
      case 'Attack': d.attack = num(value, 10) / 1000; break;
      case 'Release': d.release = num(value, 100) / 1000; break;
      case 'Knee': d.knee = num(value, 6); break;
      case 'Makeup': d.makeup.set(num(value, 0)); break;
      case 'Dry/Wet': d.mix.set(num(value, 100)); break;
    }
    if (!this.primed) d.snap();
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const d = this.dyn;
    if (ramps) {
      const r = ramps.get('Ratio'), a = ramps.get('Attack'), rel = ramps.get('Release'), k = ramps.get('Knee');
      if (r) d.ratio = r[1];
      if (a) d.attack = a[1] / 1000;
      if (rel) d.release = rel[1] / 1000;
      if (k) d.knee = k[1];
    }
    d.process(inL, inR, outL, outR, frames, ramps?.get('Threshold'), ramps?.get('Makeup'), ramps?.get('Dry/Wet'));
  }

  reset() { this.dyn.reset(); }

  reduction() { return this.dyn.reduction; }
}
