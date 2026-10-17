import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fraction, TimeSpan, PatternError } from '../src/index.ts';

const f = (n: number, d = 1) => new Fraction(n, d);

test('fractions reduce and keep the sign in the numerator', () => {
  assert.equal(String(f(6, -4)), '-3/2');
  assert.equal(String(f(4, 2)), '2');
  assert.equal(String(f(0, 7)), '0');
  assert.deepEqual([f(3, 6).n, f(3, 6).d], [1, 2]);
});

test('arithmetic is exact', () => {
  const third = f(1, 3);
  assert.ok(third.add(third).add(third).eq(1));
  assert.equal(String(f(1, 2).sub(f(2, 3))), '-1/6');
  assert.equal(String(f(3, 4).mul(f(2, 9))), '1/6');
  assert.equal(String(f(3, 4).div(f(3, 8))), '2');
  assert.equal(String(f(5, 8).neg()), '-5/8');
  assert.equal(String(f(5, 8).inverse()), '8/5');
  assert.throws(() => f(1, 0), PatternError);
  assert.throws(() => f(1).div(0), PatternError);
});

test('numbers are read as written', () => {
  assert.equal(String(Fraction.from(0.125)), '1/8');
  assert.equal(String(Fraction.from(0.1)), '1/10');
  assert.equal(String(Fraction.from(-2.5)), '-5/2');
  assert.equal(String(Fraction.from(1e-3)), '1/1000');
  assert.equal(String(Fraction.from(3)), '3');
  assert.equal(String(Fraction.from('3/8')), '3/8');
  assert.equal(String(Fraction.from('0.75')), '3/4');
  // what can't be written exactly gets its closest small fraction
  assert.equal(String(Fraction.from(1 / 3)), '1/3');
  assert.equal(String(Fraction.from(2 / 7)), '2/7');
  assert.throws(() => Fraction.from(NaN), PatternError);
  assert.throws(() => Fraction.from('x'), PatternError);
});

test('comparison, floor and cycle position', () => {
  assert.ok(f(1, 2).lt(f(2, 3)));
  assert.ok(f(2, 3).gt(f(1, 2)));
  assert.ok(f(1, 2).lte(f(2, 4)));
  assert.equal(f(1, 2).compare(f(1, 2)), 0);
  assert.equal(String(f(7, 2).floor()), '3');
  assert.equal(String(f(-7, 2).floor()), '-4');
  assert.equal(String(f(7, 2).ceil()), '4');
  assert.equal(String(f(7, 2).sam()), '3');
  assert.equal(String(f(7, 2).nextSam()), '4');
  assert.equal(String(f(7, 2).cyclePos()), '1/2');
  assert.equal(String(f(-1, 4).cyclePos()), '3/4');
  assert.equal(String(f(1, 3).min(f(1, 4))), '1/4');
  assert.equal(String(f(1, 3).max(f(1, 4))), '1/3');
  assert.equal(Number(f(3, 4)), 0.75);
});

test('too fine a fraction is an error, not a rounding', () => {
  const fine = f(1, 2 ** 27);
  assert.throws(() => fine.mul(fine), /precision/);
  assert.throws(() => f(2 ** 53, 1), /precision/, 'unsafe inputs are refused before reducing');
  assert.throws(() => f(1, 2 ** 53 + 2), /precision/);
  // products past 2^53 used to be rounded, then reduced into the safe range:
  // 1/(2^27+1) + 1/(2^27+3) came back as 1/67108865
  const a = f(1, 2 ** 27 + 1), b = f(1, 2 ** 27 + 3);
  assert.throws(() => a.add(b), /precision/);
  assert.throws(() => a.sub(b), /precision/);
  assert.throws(() => a.mul(b), /precision/);
  assert.throws(() => f(2 ** 27 + 1, 1).div(f(1, 2 ** 27 + 3)), /precision/);
});

test('big products that reduce back to exact fractions are computed exactly', () => {
  const x = f(2 ** 30 + 1, 2 ** 30 + 3);
  assert.equal(String(x.mul(x.inverse())), '1');
  assert.equal(String(x.div(x)), '1');
  assert.equal(String(x.sub(x)), '0');
  assert.equal(String(f(2 ** 30 + 1, 2 ** 30 + 3).add(f(2, 2 ** 30 + 3))), '1');
  assert.equal(String(f(2 ** 40, 3).mul(f(3, 2 ** 40))), '1');
  assert.equal(String(Fraction.fromBig(6n, -4n)), '-3/2');
  assert.throws(() => Fraction.fromBig(1n, 0n), /division by zero/);
  assert.throws(() => Fraction.fromBig(1n, 2n ** 60n), /precision/);
});

test('comparison stays exact when the cross products pass 2^53', () => {
  // a is nearer to 1 than b: 1 - 2/(2^27+3) against 1 - 2/(2^27+1)
  const a = f(2 ** 27 + 1, 2 ** 27 + 3), b = f(2 ** 27 - 1, 2 ** 27 + 1);
  assert.equal(a.compare(b), 1);
  assert.equal(b.compare(a), -1);
  assert.equal(a.compare(f(2 ** 27 + 1, 2 ** 27 + 3)), 0);
  assert.ok(a.gt(b) && b.lt(a) && !a.eq(b));
  // against BigInt arithmetic, for a sweep of near-neighbors
  for (let i = 1; i < 50; i++) {
    const p = f(2 ** 27 + i, 2 ** 27 + 2 * i + 1), q = f(2 ** 27 + i + 1, 2 ** 27 + 2 * i + 3);
    const exact = BigInt(p.n) * BigInt(q.d) - BigInt(q.n) * BigInt(p.d);
    assert.equal(p.compare(q), exact > 0n ? 1 : exact < 0n ? -1 : 0, `${p} vs ${q}`);
  }
});

test('spans split at cycle boundaries', () => {
  assert.deepEqual(new TimeSpan(f(1, 2), f(5, 2)).spanCycles().map(String), ['1/2 → 1', '1 → 2', '2 → 5/2']);
  assert.deepEqual(new TimeSpan(0, 1).spanCycles().map(String), ['0 → 1']);
  assert.deepEqual(new TimeSpan(1, 1).spanCycles().map(String), ['1 → 1']);
  assert.equal(String(new TimeSpan(f(1, 4), f(3, 4)).duration), '1/2');
  assert.equal(String(new TimeSpan(f(1, 4), f(3, 4)).midpoint), '1/2');
});

test('spans intersect, and touching is not overlapping', () => {
  const a = new TimeSpan(0, 1);
  assert.equal(String(a.intersection(new TimeSpan(f(1, 2), 2))), '1/2 → 1');
  assert.equal(a.intersection(new TimeSpan(1, 2)), undefined);
  assert.equal(a.intersection(new TimeSpan(2, 3)), undefined);
  // a zero-width span inside another is kept; at its end it isn't
  assert.equal(String(a.intersection(new TimeSpan(f(1, 2), f(1, 2)))), '1/2 → 1/2');
  assert.equal(a.intersection(new TimeSpan(1, 1)), undefined);
  assert.equal(String(a.intersection(new TimeSpan(0, 0))), '0 → 0');
  assert.ok(a.withCycle((t) => t.div(2)).equals(new TimeSpan(0, f(1, 2))));
  assert.ok(new TimeSpan(f(3, 2), 2).withCycle((t) => t.div(2)).equals(new TimeSpan(f(5, 4), f(3, 2))));
});
