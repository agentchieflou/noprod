// A pattern is a function from a span of time to the events in it. Everything
// else (sequences, stacking, speed, structure, randomness) is a way of
// building one pattern's query out of others'.

import { Fraction, type FractionLike, ZERO, ONE } from './fraction.ts';
import { TimeSpan } from './span.ts';
import { Hap, sortHaps } from './hap.ts';
import { PatternError } from './errors.ts';
import { randomAt, randomInCycle } from './random.ts';

// What one query may cost. Dictated code is untrusted: a pattern that makes
// millions of events, or takes seconds, stops with a clear error instead.
export interface Limits {
  maxEvents?: number; // events made while answering one query (every layer's, not only those returned)
  maxMillis?: number;
}

export const DEFAULT_LIMITS: Required<Limits> = { maxEvents: 20000, maxMillis: 1000 };

export class Budget {
  events = 0;
  readonly maxEvents: number;
  readonly maxMillis: number;
  readonly deadline: number;
  constructor(limits: Limits = {}) {
    this.maxEvents = limits.maxEvents ?? DEFAULT_LIMITS.maxEvents;
    this.maxMillis = limits.maxMillis ?? DEFAULT_LIMITS.maxMillis;
    this.deadline = performance.now() + this.maxMillis;
  }
  spend(events: number): void {
    this.events += events;
    if (this.events > this.maxEvents) throw new PatternError(`the pattern makes too many events (more than ${this.maxEvents} in one query)`);
    if (performance.now() > this.deadline) throw new PatternError(`the query took too long (more than ${this.maxMillis} ms)`);
  }
}

export type QueryFn<T> = (span: TimeSpan, budget: Budget) => Hap<T>[];
export type Transform<T> = (pat: Pattern<T>) => Pattern<T>;

const mod = (a: number, n: number) => ((a % n) + n) % n;

// Mini-notation strings become patterns through this hook (set by mini.ts,
// so the core doesn't depend on the parser)
let stringParser: ((s: string) => Pattern<unknown>) | undefined;
export function setStringParser(parse: (s: string) => Pattern<unknown>): void { stringParser = parse; }

// A pattern, or a value that stands for one (a string is mini-notation)
export type Patternable<T> = Pattern<T> | T;

export function reify<T>(x: Patternable<T>): Pattern<T> {
  if (x instanceof Pattern) return x;
  if (typeof x === 'string' && stringParser) return stringParser(x) as Pattern<T>;
  return pure(x);
}

export class Pattern<T = unknown> {
  readonly queryFn: QueryFn<T>;
  constructor(queryFn: QueryFn<T>) { this.queryFn = queryFn; }

  query(span: TimeSpan, budget: Budget = new Budget()): Hap<T>[] { return this.queryFn(span, budget); }

  // The events of [begin, end), in time order. Answered cycle by cycle, so
  // no fragment crosses a cycle boundary and [0, 2) is exactly [0, 1) then
  // [1, 2).
  queryArc(begin: FractionLike, end: FractionLike, limits?: Limits): Hap<T>[] {
    const budget = new Budget(limits);
    return sortHaps(new TimeSpan(begin, end).spanCycles().flatMap((s) => this.query(s, budget)));
  }

  // The events starting in the first cycle: what a loop of one bar plays
  firstCycle(limits?: Limits): Hap<T>[] { return this.onsetsOnly().queryArc(0, 1, limits); }

  // ---- plumbing

  withQuerySpan(f: (span: TimeSpan) => TimeSpan): Pattern<T> { return new Pattern((span, b) => this.query(f(span), b)); }
  withQueryTime(f: (t: Fraction) => Fraction): Pattern<T> { return this.withQuerySpan((span) => span.withTime(f)); }
  withHapSpan(f: (span: TimeSpan) => TimeSpan): Pattern<T> { return new Pattern((span, b) => this.query(span, b).map((h) => h.withSpan(f))); }
  withHapTime(f: (t: Fraction) => Fraction): Pattern<T> { return this.withHapSpan((span) => span.withTime(f)); }
  withHaps<U>(f: (haps: Hap<T>[]) => Hap<U>[]): Pattern<U> { return new Pattern((span, b) => f(this.query(span, b))); }
  withHap<U>(f: (hap: Hap<T>) => Hap<U>): Pattern<U> { return this.withHaps((haps) => haps.map(f)); }
  fmap<U>(f: (value: T) => U): Pattern<U> { return this.withHap((h) => h.withValue(f)); }
  filterHaps(keep: (hap: Hap<T>) => boolean): Pattern<T> { return this.withHaps((haps) => haps.filter(keep)); }
  filterValues(keep: (value: T) => boolean): Pattern<T> { return this.filterHaps((h) => keep(h.value)); }
  onsetsOnly(): Pattern<T> { return this.filterHaps((h) => h.hasOnset()); }
  // Answer each cycle of a query on its own
  splitQueries(): Pattern<T> { return new Pattern((span, b) => span.spanCycles().flatMap((s) => this.query(s, b))); }

  // ---- combining with other patterns

  // Structure from this pattern; values combined with the other's at each event
  appLeft<U, V>(other: Pattern<U>, f: (a: T, b: U) => V): Pattern<V> {
    return new Pattern((span, b) => {
      const out: Hap<V>[] = [];
      for (const left of this.query(span, b)) {
        for (const right of other.query(left.wholeOrPart(), b)) {
          const part = left.part.intersection(right.part);
          if (part) out.push(new Hap(left.whole, part, f(left.value, right.value)));
        }
      }
      b.spend(out.length);
      return out;
    });
  }

  // Structure from both: an event wherever two overlap
  appBoth<U, V>(other: Pattern<U>, f: (a: T, b: U) => V): Pattern<V> {
    return new Pattern((span, b) => {
      const out: Hap<V>[] = [];
      const rights = other.query(span, b);
      for (const left of this.query(span, b)) {
        for (const right of rights) {
          const part = left.part.intersection(right.part);
          if (!part) continue;
          let whole: TimeSpan | undefined;
          if (left.whole && right.whole) {
            whole = left.whole.intersection(right.whole);
            if (!whole) continue;
          }
          out.push(new Hap(whole, part, f(left.value, right.value)));
        }
      }
      b.spend(out.length);
      return out;
    });
  }

  // ---- joins, for patterns of patterns

  // Structure from the inner patterns; the outer one only says which plays when
  innerJoin<U>(this: Pattern<Pattern<U>>): Pattern<U> {
    return new Pattern((span, b) => {
      const out: Hap<U>[] = [];
      for (const outer of this.query(span, b)) {
        for (const inner of outer.value.query(outer.part, b)) {
          const part = inner.part.intersection(outer.part);
          if (part) out.push(new Hap(inner.whole, part, inner.value));
        }
      }
      b.spend(out.length);
      return out;
    });
  }

  // Structure from the outer pattern; each event takes the inner value at its onset
  outerJoin<U>(this: Pattern<Pattern<U>>): Pattern<U> {
    return new Pattern((span, b) => {
      const out: Hap<U>[] = [];
      for (const outer of this.query(span, b)) {
        const onset = outer.wholeOrPart().begin;
        for (const inner of outer.value.query(new TimeSpan(onset, onset), b)) out.push(new Hap(outer.whole, outer.part, inner.value));
      }
      b.spend(out.length);
      return out;
    });
  }

  // Each outer event gets a whole cycle of its inner pattern squeezed into it
  squeezeJoin<U>(this: Pattern<Pattern<U>>): Pattern<U> {
    return new Pattern((span, b) => {
      const out: Hap<U>[] = [];
      for (const outer of this.query(span, b)) {
        const inner = outer.value.focus(outer.wholeOrPart());
        for (const hap of inner.query(outer.part, b)) {
          const part = outer.part.intersection(hap.part);
          if (!part) continue;
          let whole: TimeSpan | undefined;
          if (outer.whole && hap.whole) {
            whole = outer.whole.intersection(hap.whole);
            if (!whole) continue;
          }
          out.push(new Hap(whole, part, hap.value));
        }
      }
      b.spend(out.length);
      return out;
    });
  }

  // ---- time

  // Cycle 0 of this pattern laid over the span (cycle 1 over the next, and so on)
  focus(span: TimeSpan): Pattern<T> {
    const d = span.duration;
    if (d.isZero()) return silence;
    return this.withQueryTime((t) => t.sub(span.begin).div(d)).withHapTime((t) => span.begin.add(t.mul(d)));
  }

  // Each cycle of this pattern squeezed into [begin, end) of its cycle, with
  // silence around it
  compress(begin: FractionLike, end: FractionLike): Pattern<T> {
    const b = Fraction.from(begin), e = Fraction.from(end);
    if (b.lt(0) || e.gt(1) || b.gte(e)) return silence;
    const d = e.sub(b);
    return new Pattern((span, budget) => span.spanCycles().flatMap((s) => {
      const cycle = s.begin.sam();
      const inside = s.intersection(new TimeSpan(cycle.add(b), cycle.add(e)));
      if (!inside) return [];
      const toInner = (t: Fraction) => cycle.add(t.sub(cycle).sub(b).div(d));
      const fromInner = (t: Fraction) => cycle.add(t.sub(cycle).mul(d).add(b));
      return this.query(inside.withTime(toInner), budget).map((h) => h.withSpan((sp) => sp.withTime(fromInner)));
    }));
  }

  fast(factor: Patternable<FractionLike>): Pattern<T> { return patternify((f: FractionLike, pat: Pattern<T>) => pat._fast(f))(factor, this); }
  slow(factor: Patternable<FractionLike>): Pattern<T> { return patternify((f: FractionLike, pat: Pattern<T>) => pat._slow(f))(factor, this); }
  early(time: Patternable<FractionLike>): Pattern<T> { return patternify((t: FractionLike, pat: Pattern<T>) => pat._early(t))(time, this); }
  late(time: Patternable<FractionLike>): Pattern<T> { return patternify((t: FractionLike, pat: Pattern<T>) => pat._late(t))(time, this); }

  _fast(factor: FractionLike): Pattern<T> {
    const f = Fraction.from(factor);
    if (f.lte(0)) return silence;
    return this.withQueryTime((t) => t.mul(f)).withHapTime((t) => t.div(f));
  }
  _slow(factor: FractionLike): Pattern<T> {
    const f = Fraction.from(factor);
    return f.lte(0) ? silence : this._fast(f.inverse());
  }
  _early(time: FractionLike): Pattern<T> {
    const t = Fraction.from(time);
    return this.withQueryTime((x) => x.add(t)).withHapTime((x) => x.sub(t));
  }
  _late(time: FractionLike): Pattern<T> { return this._early(Fraction.from(time).neg()); }

  // Each cycle backwards
  rev(): Pattern<T> {
    return new Pattern((span, b) => span.spanCycles().flatMap((s) => {
      const cycle = s.begin.sam();
      const reflect = (t: Fraction) => cycle.add(cycle.add(1).sub(t));
      const mirror = (sp: TimeSpan) => new TimeSpan(reflect(sp.end), reflect(sp.begin));
      return this.query(mirror(s), b).map((h) => h.withSpan(mirror));
    }));
  }

  // Forwards one cycle, backwards the next
  palindrome(): Pattern<T> { return slowcat(this, this.rev()); }

  // Cycle c starts c/n of the way in: "a b c d" → "b c d a" → ...
  iter(n: number, backwards = false): Pattern<T> {
    if (!Number.isInteger(n) || n <= 0) throw new PatternError(`iter wants a positive whole number, not ${n}`);
    return slowcat(...Array.from({ length: n }, (_, i) => (backwards ? this._late(new Fraction(i, n)) : this._early(new Fraction(i, n)))));
  }

  // Every event repeated n times within its own span
  ply(n: Patternable<FractionLike>): Pattern<T> {
    return patternify((k: FractionLike, pat: Pattern<T>) => pat.fmap((v) => pure(v)._fast(k)).squeezeJoin())(n, this);
  }

  // The pattern, plus a copy shifted later by `time` and transformed
  off(time: Patternable<FractionLike>, f: Transform<T>): Pattern<T> {
    return patternify((t: FractionLike, pat: Pattern<T>) => stack(pat, f(pat._late(t))))(time, this);
  }

  superimpose(f: Transform<T>): Pattern<T> { return stack(this, f(this)); }
  layer(...fs: Transform<T>[]): Pattern<T> { return stack(...fs.map((f) => f(this))); }

  // ---- structure

  // f applied to the first of every n cycles (cycles 0, n, 2n, ...)
  every(n: Patternable<number>, f: Transform<T>): Pattern<T> {
    return patternify((k: number, pat: Pattern<T>) => pat._every(k, f))(n, this);
  }
  _every(n: number, f: Transform<T>): Pattern<T> {
    if (!Number.isInteger(n)) throw new PatternError(`every wants a whole number of cycles, not ${n}`);
    if (n <= 0) return this;
    const changed = f(this);
    return new Pattern((span, b) => span.spanCycles().flatMap((s) => (mod(Number(s.begin.sam()), n) === 0 ? changed : this).query(s, b)));
  }
  // f applied to the last of every n cycles instead
  lastOf(n: Patternable<number>, f: Transform<T>): Pattern<T> {
    return patternify((k: number, pat: Pattern<T>) => {
      if (!Number.isInteger(k)) throw new PatternError(`lastOf wants a whole number of cycles, not ${k}`);
      if (k <= 0) return pat;
      const changed = f(pat);
      return new Pattern((span, b) => span.spanCycles().flatMap((s) => (mod(Number(s.begin.sam()), k) === k - 1 ? changed : pat).query(s, b)));
    })(n, this);
  }

  // The rhythm of `bools`, with this pattern's values where they are true
  struct(bools: Patternable<unknown>): Pattern<T> {
    return reify(bools).filterValues(Boolean).appLeft(this, (_b, v) => v);
  }
  // Only the events where `bools` is true (the rhythm stays this pattern's)
  mask(bools: Patternable<unknown>): Pattern<T> {
    return this.appLeft(reify(bools), (v, keep) => (keep ? v : undefined))
      .filterValues((v) => v !== undefined) as Pattern<T>;
  }

  // A Euclidean rhythm: k hits spread as evenly as possible over n steps,
  // turned `rotation` steps later (a negative k inverts hits and rests)
  euclid(hits: Patternable<number>, steps: Patternable<number>, rotation: Patternable<number> = 0): Pattern<T> {
    return patternify((k: number, pat: Pattern<T>) => patternify((n: number, p: Pattern<T>) => patternify((r: number, q: Pattern<T>) =>
      q.struct(euclidBools(k, n, r)))(rotation, p))(steps, pat))(hits, this);
  }

  // ---- randomness (seeded: the same pattern always gives the same events)

  // Drops each event with probability p
  degradeBy(p: Patternable<number>, seed = 0): Pattern<T> {
    return patternify((x: number, pat: Pattern<T>) => pat._degradeBy(x, seed))(p, this);
  }
  _degradeBy(p: number, seed = 0): Pattern<T> { return this.filterHaps((h) => randomAt(h.wholeOrPart().begin, seed) >= p); }
  // Keeps exactly the events degradeBy(p) drops
  _undegradeBy(p: number, seed = 0): Pattern<T> { return this.filterHaps((h) => randomAt(h.wholeOrPart().begin, seed) < p); }
  degrade(seed = 0): Pattern<T> { return this._degradeBy(0.5, seed); }

  // f applied to a random share p of the events
  sometimesBy(p: Patternable<number>, f: Transform<T>, seed = 0): Pattern<T> {
    return patternify((x: number, pat: Pattern<T>) => stack(pat._degradeBy(x, seed), f(pat._undegradeBy(x, seed))))(p, this);
  }
  sometimes(f: Transform<T>, seed = 0): Pattern<T> { return this.sometimesBy(0.5, f, seed); }
  often(f: Transform<T>, seed = 0): Pattern<T> { return this.sometimesBy(0.75, f, seed); }
  rarely(f: Transform<T>, seed = 0): Pattern<T> { return this.sometimesBy(0.25, f, seed); }
  almostAlways(f: Transform<T>, seed = 0): Pattern<T> { return this.sometimesBy(0.9, f, seed); }
  almostNever(f: Transform<T>, seed = 0): Pattern<T> { return this.sometimesBy(0.1, f, seed); }
  always(f: Transform<T>): Pattern<T> { return f(this); }
  never(): Pattern<T> { return this; }
  // f applied to whole cycles, each with probability p
  someCyclesBy(p: Patternable<number>, f: Transform<T>, seed = 0): Pattern<T> {
    return patternify((x: number, pat: Pattern<T>) => {
      const changed = f(pat);
      return new Pattern((span, b) => span.spanCycles().flatMap((s) => (randomInCycle(Number(s.begin.sam()), seed) < x ? changed : pat).query(s, b)));
    })(p, this);
  }
  someCycles(f: Transform<T>, seed = 0): Pattern<T> { return this.someCyclesBy(0.5, f, seed); }
}

// ---- constructors

export const silence: Pattern<never> = new Pattern(() => []);

// One event per cycle
export function pure<T>(value: T): Pattern<T> {
  return new Pattern((span, b) => {
    const haps = span.spanCycles().flatMap((s) => {
      const whole = new TimeSpan(s.begin.sam(), s.begin.nextSam());
      const part = whole.intersection(s);
      return part ? [new Hap(whole, part, value)] : [];
    });
    b.spend(haps.length);
    return haps;
  });
}

// A continuous value: sampled at the middle of each query, no onsets
export function signal<T>(f: (t: Fraction) => T): Pattern<T> {
  return new Pattern((span, b) => { b.spend(1); return [new Hap(undefined, span, f(span.midpoint))]; });
}
export const rand = (seed = 0): Pattern<number> => signal((t) => randomAt(t, seed));
export const sine: Pattern<number> = signal((t) => (Math.sin(2 * Math.PI * Number(t)) + 1) / 2);
export const cosine: Pattern<number> = sine._early(new Fraction(1, 4));
export const saw: Pattern<number> = signal((t) => Number(t.cyclePos()));
export const isaw: Pattern<number> = signal((t) => 1 - Number(t.cyclePos()));
export const tri: Pattern<number> = signal((t) => { const x = Number(t.cyclePos()); return x < 0.5 ? 2 * x : 2 - 2 * x; });
export const square: Pattern<number> = signal((t) => (Number(t.cyclePos()) < 0.5 ? 0 : 1));

// All at once
export function stack<T>(...pats: Patternable<T>[]): Pattern<T> {
  const ps = pats.map(reify);
  return new Pattern((span, b) => ps.flatMap((p) => p.query(span, b)));
}

// One pattern per cycle, in turn. Each pattern counts its own cycles, so
// "<a <b c>>" plays a b a c.
export function slowcat<T>(...pats: Patternable<T>[]): Pattern<T> {
  const ps = pats.map(reify);
  if (ps.length === 0) return silence;
  if (ps.length === 1) return ps[0];
  const n = ps.length;
  return new Pattern((span, b) => span.spanCycles().flatMap((s) => {
    const cycle = Number(s.begin.sam());
    const i = mod(cycle, n);
    const offset = new Fraction(cycle - (cycle - i) / n);
    return ps[i].query(s.withTime((t) => t.sub(offset)), b).map((h) => h.withSpan((sp) => sp.withTime((t) => t.add(offset))));
  }));
}
export const cat = slowcat;

// All in one cycle, each the same length
export function fastcat<T>(...pats: Patternable<T>[]): Pattern<T> {
  return timecat(...pats.map((p) => [1, p] as [FractionLike, Patternable<T>]));
}
export const sequence = fastcat;
export const seq = fastcat;

// All in one cycle, each as long as its weight says
export function timecat<T>(...pairs: [FractionLike, Patternable<T>][]): Pattern<T> {
  const weighted = pairs.map(([w, p]) => [Fraction.from(w), reify(p)] as const).filter(([w]) => w.gt(0));
  if (weighted.length === 0) return silence;
  const total = weighted.reduce((sum, [w]) => sum.add(w), ZERO);
  let begin = ZERO;
  const parts: Pattern<T>[] = [];
  for (const [w, p] of weighted) {
    const end = begin.add(w);
    parts.push(p.compress(begin.div(total), end.div(total)));
    begin = end;
  }
  return stack(...parts);
}

// One pattern per cycle, chosen at random (seeded)
export function randcat<T>(pats: Patternable<T>[], seed = 0): Pattern<T> {
  const ps = pats.map(reify);
  if (ps.length === 0) return silence;
  return new Pattern((span, b) => span.spanCycles().flatMap((s) =>
    ps[Math.floor(randomInCycle(Number(s.begin.sam()), seed) * ps.length)].query(s, b)));
}

// A random pick from the values, once per cycle (seeded)
export function choose<T>(values: T[], seed = 0): Pattern<T> { return randcat(values.map(pure), seed); }

// Polymeter: every sequence gets `steps` steps per cycle (the first one's
// length by default), so "{a b c, d e}%4" steps through each at the same rate
export function polymeter<T>(sequences: Patternable<T>[][], steps?: number): Pattern<T> {
  const nonEmpty = sequences.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return silence;
  const n = steps ?? nonEmpty[0].length;
  return stack(...nonEmpty.map((s) => fastcat(...s)._fast(new Fraction(n, s.length))));
}

// ---- patterned arguments

// Lifts a function of a plain argument to one of a patterned argument: each
// value of the argument pattern applies while it lasts (the structure stays
// the transformed pattern's)
export function patternify<A, T, U>(f: (arg: A, pat: Pattern<T>) => Pattern<U>): (arg: Patternable<A>, pat: Pattern<T>) => Pattern<U> {
  return (arg, pat) => {
    if (arg instanceof Pattern) return arg.fmap((a: A) => f(a, pat)).innerJoin();
    if (typeof arg === 'string' && stringParser) return (reify(arg) as Pattern<A>).fmap((a) => f(a, pat)).innerJoin();
    return f(arg as A, pat);
  };
}

// ---- Euclidean rhythms

// Bjorklund's algorithm: k hits over n steps, as evenly spread as they can be
export function bjorklund(hits: number, steps: number): boolean[] {
  if (!Number.isInteger(hits) || !Number.isInteger(steps) || steps < 0) throw new PatternError(`not a Euclidean rhythm: (${hits},${steps})`);
  if (steps === 0) return [];
  hits = Math.min(Math.abs(hits), steps);
  if (hits === 0) return new Array<boolean>(steps).fill(false);
  // Start with k groups of [1] and n-k of [0]; keep distributing the
  // remainder among the groups until it is a single group or empty
  let groups: boolean[][] = Array.from({ length: hits }, () => [true]);
  let remainder: boolean[][] = Array.from({ length: steps - hits }, () => [false]);
  while (remainder.length > 1) {
    const count = Math.min(groups.length, remainder.length);
    const next: boolean[][] = [];
    for (let i = 0; i < count; i++) next.push([...groups[i], ...remainder[i]]);
    const leftover = groups.length > count ? groups.slice(count) : remainder.slice(count);
    groups = next;
    remainder = leftover;
  }
  return [...groups, ...remainder].flat();
}

export function euclidBools(hits: number, steps: number, rotation = 0): Pattern<boolean> {
  if (!Number.isInteger(rotation)) throw new PatternError(`a Euclidean rotation is a whole number, not ${rotation}`);
  let bools = bjorklund(hits, steps);
  if (hits < 0) bools = bools.map((b) => !b);
  if (bools.length === 0) return silence;
  const r = mod(-rotation, bools.length);
  bools = [...bools.slice(r), ...bools.slice(0, r)];
  return fastcat(...bools.map(pure));
}

export { Fraction, TimeSpan, Hap, PatternError, ZERO, ONE };
