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
