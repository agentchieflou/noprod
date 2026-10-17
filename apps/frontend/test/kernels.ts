// Shared by the device kernel tests: signals, a block driver, measures.

import { createRandom } from '@noprod/sound';
import type { DeviceKernel, ParamValue } from '../src/audio/dsp/devices/index.ts';

export const SR = 48000;
export const BLOCK = 128;

export const noise = (frames: number, level = 0.25, seed = 1) => {
  const random = createRandom(seed);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (random() * 2 - 1) * level;
  return out;
};

export const sine = (frames: number, hz: number, level = 0.5, sr = SR, phase = 0) =>
  Float32Array.from({ length: frames }, (_, i) => level * Math.sin(phase + (2 * Math.PI * hz * i) / sr));

export const silence = (frames: number) => new Float32Array(frames);

export const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// Runs `kernel` over the whole signal in blocks (`sizes` cycles through the
// block lengths; 128 by default) and returns the output
export const run = (kernel: DeviceKernel, l: Float32Array, r: Float32Array, sizes: number[] = [BLOCK], ramps?: (block: number) => ReadonlyMap<string, [number, number]> | undefined) => {
  const outL = new Float32Array(l.length), outR = new Float32Array(r.length);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), ol = new Float32Array(BLOCK), or = new Float32Array(BLOCK);
  let at = 0, k = 0;
  while (at < l.length) {
    const n = Math.min(sizes[k % sizes.length], l.length - at);
    bl.set(l.subarray(at, at + n)); br.set(r.subarray(at, at + n));
    kernel.process(bl, br, ol, or, n, ramps?.(k));
    outL.set(ol.subarray(0, n), at); outR.set(or.subarray(0, n), at);
    at += n; k++;
  }
  return { l: outL, r: outR };
};

export const set = (kernel: DeviceKernel, params: Record<string, ParamValue>) => {
  for (const [name, value] of Object.entries(params)) kernel.set(name, value, 0);
  return kernel;
};

export const maxAbsDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

export const identical = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

export const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

export const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

// The magnitude of `x` at `hz`, in dB relative to full scale, over [from, to)
// (a Goertzel-like projection; the window is a whole number of cycles when
// the caller picks one)
export const magnitudeAt = (x: Float32Array, hz: number, sr: number, from: number, to: number) => {
  let re = 0, im = 0;
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * hz * i) / sr;
    re += x[i] * Math.cos(w); im -= x[i] * Math.sin(w);
  }
  const n = to - from;
  return db((2 * Math.hypot(re, im)) / n);
};

// Pearson correlation of two signals
export const correlation = (a: Float32Array, b: Float32Array) => {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length, mb = sb / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return cov / Math.sqrt(va * vb || 1);
};

// Median of a list of numbers
export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export const hasSubnormal = (a: Float32Array) => a.some((v) => v !== 0 && Math.abs(v) < 1.1754943508222875e-38);
