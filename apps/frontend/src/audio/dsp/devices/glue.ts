// Glue Compressor: the bus compressor modelled on the classic console
// design: stepped ratio, attack and release (with program-dependent Auto
// release), a Range that caps the reduction, a hard or soft knee, and an
// optional output soft clipper. The same dynamics loop as the Compressor,
// with its enums mapped as the native device maps them.

import { num, type DeviceKernel, type ParamValue } from './kernel.ts';
import { Dynamics } from './dynamics.ts';

export class Glue implements DeviceKernel {
  readonly kind = 'glue';
  readonly latency = 0;
  private readonly dyn: Dynamics;
  private primed = false;

  constructor(sampleRate: number) {
    this.dyn = new Dynamics(sampleRate, 0, 100);
    this.dyn.threshold = -10;
    this.dyn.release = 0;        // Auto
    this.dyn.knee = 0;           // Classic
    this.dyn.range = 70;
  }

  tail() { return 0; }

  set(name: string, value: ParamValue) {
    const d = this.dyn;
    switch (name) {
      case 'Threshold': d.threshold = num(value, -10); break;
      case 'Ratio': d.ratio = num(value, 4); break;                            // '4:1' -> 4
      case 'Attack': d.attack = num(value, 10) / 1000; break;                  // '10 ms' -> 0.01 s
      case 'Release': d.release = value === 'Auto' ? 0 : num(value, 0.4); break; // '0.4 s' -> 0.4; 0 = auto
      case 'Makeup': d.makeup.set(num(value, 0)); break;
      case 'Range': d.range = num(value, 70); break;
      case 'Knee': d.knee = value === 'Soft' ? 10 : 0; break;
      case 'Soft Clip': d.softClip = value === true; break;
      case 'Dry/Wet': d.mix.set(num(value, 100)); break;
    }
    if (!this.primed) d.snap();
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const range = ramps?.get('Range');
    if (range) this.dyn.range = range[1];
    this.dyn.process(inL, inR, outL, outR, frames, ramps?.get('Threshold'), ramps?.get('Makeup'), ramps?.get('Dry/Wet'));
  }

  reset() { this.dyn.reset(); }

  reduction() { return this.dyn.reduction; }
}
