// @noprod/pattern: noprod's pattern engine, built from scratch. Time is
// measured in cycles as exact fractions; a pattern answers "which events
// overlap this span", and the mini-notation and the functions build patterns.

export { Fraction, fraction, ZERO, ONE } from './fraction.ts';
export type { FractionLike } from './fraction.ts';
export { TimeSpan } from './span.ts';
export { Hap, sortHaps } from './hap.ts';
export { PatternError } from './errors.ts';
export { randomAt, randomInCycle, hashNumbers } from './random.ts';
export {
  Pattern, Budget, DEFAULT_LIMITS, reify, setStringParser, patternify,
  silence, pure, signal, rand, sine, cosine, saw, isaw, tri, square,
  stack, slowcat, cat, fastcat, sequence, seq, timecat, randcat, choose, polymeter,
  bjorklund, euclidBools
} from './pattern.ts';
export type { Limits, QueryFn, Transform, Patternable } from './pattern.ts';
