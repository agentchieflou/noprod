// Deterministic randomness: a value in [0, 1) from a time and a seed, so the
// same pattern always gives the same events. Different seeds (each `?` in a
// mini-notation string gets its own) give independent streams.

import type { Fraction } from './fraction.ts';

// A 32-bit integer mix (the finalizer of a MurmurHash3-style hash)
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hashNumbers(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    // the number's two 32-bit halves, so fractions with big parts still differ
    const lo = x >>> 0;
    const hi = Math.floor(Math.abs(x) / 2 ** 32) >>> 0;
    h = mix(h ^ mix(lo + 0x7f4a7c15));
    h = mix(h ^ mix(hi + (x < 0 ? 0x5bd1e995 : 0x1b873593)));
  }
  return h;
}

// Random in [0, 1) at a time (as a reduced fraction, so equal times agree)
export function randomAt(time: Fraction, seed = 0): number {
  return hashNumbers(time.n, time.d, seed) / 2 ** 32;
}

// Random in [0, 1) for a cycle number
export function randomInCycle(cycle: number, seed = 0): number {
  return hashNumbers(cycle, 1, seed, 0x2545f491) / 2 ** 32;
}
