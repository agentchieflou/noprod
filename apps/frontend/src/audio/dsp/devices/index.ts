// The stock devices as kernels for the engine worklet (#159, step 5), by
// the `kind` devices.ts gives them; `panner` and `limiter` are the strip's
// own. Nothing here is wired into the engine yet.

import type { DeviceKernel } from './kernel.ts';
import { EqThree } from './eq3.ts';
import { EqEight } from './eq8.ts';

export type { DeviceKernel, ParamValue } from './kernel.ts';
export { Smoothed, Mix, dbToGain } from './kernel.ts';
export { EqThree, EqEight };

export const KERNEL_KINDS = ['eq3', 'eq8'] as const;
export type KernelKind = (typeof KERNEL_KINDS)[number];

export function makeKernel(kind: string, sampleRate: number): DeviceKernel | null {
  switch (kind) {
    case 'eq3': return new EqThree(sampleRate);
    case 'eq8': return new EqEight(sampleRate);
    default: return null;
  }
}
