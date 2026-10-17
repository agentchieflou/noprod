// An event: a value over a whole span, of which this query sees the part.
// A whole of undefined is a sample of a continuous signal, with no onset.

import type { Fraction } from './fraction.ts';
import { TimeSpan } from './span.ts';

export class Hap<T> {
  readonly whole: TimeSpan | undefined;
  readonly part: TimeSpan;
  readonly value: T;
  constructor(whole: TimeSpan | undefined, part: TimeSpan, value: T) {
    this.whole = whole;
    this.part = part;
    this.value = value;
  }

  // The event starts inside this part (so this is where it is played)
  hasOnset(): boolean { return this.whole !== undefined && this.whole.begin.eq(this.part.begin); }
  wholeOrPart(): TimeSpan { return this.whole ?? this.part; }
  get duration(): Fraction { return this.wholeOrPart().duration; }

  withSpan(f: (span: TimeSpan) => TimeSpan): Hap<T> { return new Hap(this.whole && f(this.whole), f(this.part), this.value); }
  withValue<U>(f: (value: T) => U): Hap<U> { return new Hap(this.whole, this.part, f(this.value)); }
  setValue<U>(value: U): Hap<U> { return new Hap(this.whole, this.part, value); }

  toString(): string {
    const whole = this.whole ? `${this.whole}` : '~';
    const part = this.whole && this.whole.equals(this.part) ? '' : ` (${this.part})`;
    return `${whole}${part}: ${JSON.stringify(this.value)}`;
  }
}

// Events in time order; those starting together stay in the order their
// pattern gave them (a stack's layers, say)
export function sortHaps<T>(haps: Hap<T>[]): Hap<T>[] {
  return [...haps].sort((a, b) => a.part.begin.compare(b.part.begin) || a.wholeOrPart().begin.compare(b.wholeOrPart().begin));
}
