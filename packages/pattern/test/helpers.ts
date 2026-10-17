import { Pattern, type Hap } from '../src/index.ts';

// An event as "begin duration value" ("1/2 1/4 bd"), the way the expected
// events in these tests are written out by hand
export const show = (h: Hap<unknown>): string => {
  const span = h.wholeOrPart();
  const v = typeof h.value === 'string' ? h.value : JSON.stringify(h.value);
  return `${span.begin} ${span.duration} ${v}`;
};

// The events starting in [0, cycles), in time order
export const events = (pat: Pattern<unknown>, cycles = 1, from = 0): string[] =>
  pat.onsetsOnly().queryArc(from, cycles).map(show);

// Every event fragment in the span, with its part when it isn't the whole
export const fragments = (pat: Pattern<unknown>, begin: number, end: number): string[] =>
  pat.queryArc(begin, end).map((h) => h.toString());
