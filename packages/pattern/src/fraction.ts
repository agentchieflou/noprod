// Exact time. A cycle position is a rational number, so a 3-against-4 or a
// fast(7) never drifts: 1/3 + 1/3 + 1/3 is exactly 1.

import { PatternError } from './errors.ts';

export type FractionLike = Fraction | number | string;

const gcd = (a: number, b: number): number => {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
};

export class Fraction {
  readonly n: number; // numerator, carries the sign
  readonly d: number; // denominator, always positive

  constructor(n: number, d = 1) {
    if (!Number.isInteger(n) || !Number.isInteger(d)) throw new PatternError(`not a fraction: ${n}/${d}`);
    if (d === 0) throw new PatternError('division by zero');
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d) || 1;
    this.n = n / g;
    this.d = d / g;
    if (!Number.isSafeInteger(this.n) || !Number.isSafeInteger(this.d)) {
      throw new PatternError('time precision exceeded (fractions too fine)');
    }
  }

  // A number is read exactly as written (0.125 is 1/8, 1e-3 is 1/1000)
  static from(x: FractionLike): Fraction {
    if (x instanceof Fraction) return x;
    if (typeof x === 'string') {
      const m = /^\s*(-?\d+)\s*\/\s*(\d+)\s*$/.exec(x);
      if (m) return new Fraction(Number(m[1]), Number(m[2]));
      x = Number(x);
    }
    if (!Number.isFinite(x)) throw new PatternError(`not a number: ${x}`);
    if (Number.isInteger(x)) return new Fraction(x);
    // decimal digits and exponent, from how JavaScript prints the number
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(x.toString());
    if (!m) throw new PatternError(`not a number: ${x}`);
    const digits = m[2] + (m[3] ?? '');
    const exponent = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
    let n = Number(digits) * (m[1] ? -1 : 1);
    let d = 1;
    if (exponent >= 0) n *= 10 ** exponent;
    else d = 10 ** -exponent;
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) return Fraction.approximate(x);
    return new Fraction(n, d);
  }

  // The closest fraction with a denominator up to 1e9 (continued fractions)
  static approximate(x: number, maxDenominator = 1e9): Fraction {
    let [h0, h1, k0, k1] = [0, 1, 1, 0];
    let r = x;
    for (let i = 0; i < 64; i++) {
      const a = Math.floor(r);
      const [h2, k2] = [a * h1 + h0, a * k1 + k0];
      if (k2 > maxDenominator) break;
      [h0, h1, k0, k1] = [h1, h2, k1, k2];
      if (r === a) break;
      r = 1 / (r - a);
    }
    return new Fraction(h1, k1);
  }

  add(o: FractionLike): Fraction { const b = Fraction.from(o); return new Fraction(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(o: FractionLike): Fraction { const b = Fraction.from(o); return new Fraction(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(o: FractionLike): Fraction { const b = Fraction.from(o); return new Fraction(this.n * b.n, this.d * b.d); }
  div(o: FractionLike): Fraction { const b = Fraction.from(o); return new Fraction(this.n * b.d, this.d * b.n); }
  neg(): Fraction { return new Fraction(-this.n, this.d); }
  inverse(): Fraction { return new Fraction(this.d, this.n); }

  compare(o: FractionLike): number { const b = Fraction.from(o); return Math.sign(this.n * b.d - b.n * this.d); }
  eq(o: FractionLike): boolean { return this.compare(o) === 0; }
  lt(o: FractionLike): boolean { return this.compare(o) < 0; }
  lte(o: FractionLike): boolean { return this.compare(o) <= 0; }
  gt(o: FractionLike): boolean { return this.compare(o) > 0; }
  gte(o: FractionLike): boolean { return this.compare(o) >= 0; }
  min(o: FractionLike): Fraction { return this.lte(o) ? this : Fraction.from(o); }
  max(o: FractionLike): Fraction { return this.gte(o) ? this : Fraction.from(o); }

  floor(): Fraction { return new Fraction(Math.floor(this.n / this.d)); }
  ceil(): Fraction { return new Fraction(Math.ceil(this.n / this.d)); }
  // The cycle this time is in (its start), and the next one
  sam(): Fraction { return this.floor(); }
  nextSam(): Fraction { return this.floor().add(1); }
  // Where in its cycle this time is, in [0, 1)
  cyclePos(): Fraction { return this.sub(this.sam()); }

  isZero(): boolean { return this.n === 0; }
  valueOf(): number { return this.n / this.d; }
  toString(): string { return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`; }
}

export const fraction = (x: FractionLike): Fraction => Fraction.from(x);
export const ZERO = new Fraction(0);
export const ONE = new Fraction(1);
