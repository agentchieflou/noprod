// A span of time in cycles: [begin, end). Events have two: the whole they
// belong to, and the part of it inside the query.

import { Fraction, type FractionLike } from './fraction.ts';

export class TimeSpan {
  readonly begin: Fraction;
  readonly end: Fraction;

  constructor(begin: FractionLike, end: FractionLike) {
    this.begin = Fraction.from(begin);
    this.end = Fraction.from(end);
  }

  get duration(): Fraction { return this.end.sub(this.begin); }
  get midpoint(): Fraction { return this.begin.add(this.end).div(2); }

  // The span cut at cycle boundaries, one piece per cycle it touches
  spanCycles(): TimeSpan[] {
    const pieces: TimeSpan[] = [];
    if (this.begin.eq(this.end)) return [new TimeSpan(this.begin, this.end)];
    let begin = this.begin;
    while (begin.lt(this.end)) {
      const end = begin.nextSam().min(this.end);
      pieces.push(new TimeSpan(begin, end));
      begin = end;
    }
    return pieces;
  }

  withTime(f: (t: Fraction) => Fraction): TimeSpan { return new TimeSpan(f(this.begin), f(this.end)); }
  withCycle(f: (t: Fraction) => Fraction): TimeSpan {
    const sam = this.begin.sam();
    return new TimeSpan(sam.add(f(this.begin.sub(sam))), sam.add(f(this.end.sub(sam))));
  }

  // The overlap, or undefined when there is none. Two spans that only touch
  // don't overlap, except that a zero-width span inside another does.
  intersection(o: TimeSpan): TimeSpan | undefined {
    const begin = this.begin.max(o.begin);
    const end = this.end.min(o.end);
    if (begin.gt(end)) return undefined;
    if (begin.eq(end)) {
      if (begin.eq(this.end) && this.begin.lt(this.end)) return undefined;
      if (begin.eq(o.end) && o.begin.lt(o.end)) return undefined;
    }
    return new TimeSpan(begin, end);
  }

  equals(o: TimeSpan): boolean { return this.begin.eq(o.begin) && this.end.eq(o.end); }
  toString(): string { return `${this.begin} → ${this.end}`;
  }
}
