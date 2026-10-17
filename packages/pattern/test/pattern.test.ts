import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Pattern, Fraction, TimeSpan, PatternError, pure, silence, signal, rand, saw, sine,
  stack, slowcat, cat, fastcat, seq, timecat, randcat, choose, polymeter, bjorklund, euclidBools, patternify
} from '../src/index.ts';
import { events, fragments } from './helpers.ts';

const bools = (pat: Pattern<boolean>) => pat.firstCycle().map((h) => (h.value ? 'x' : '.')).join('');

test('pure: one event per cycle, cut to the query', () => {
  assert.deepEqual(events(pure('a'), 2), ['0 1 a', '1 1 a']);
  assert.deepEqual(fragments(pure('a'), 0.5, 1.5), ['0 → 1 (1/2 → 1): "a"', '1 → 2 (1 → 3/2): "a"']);
  assert.deepEqual(fragments(pure('a'), 0.25, 0.75), ['0 → 1 (1/4 → 3/4): "a"']);
  assert.deepEqual(events(silence, 4), []);
});

test('fastcat: the cycle shared equally', () => {
  assert.deepEqual(events(fastcat('a', 'b', 'c')), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 c']);
  assert.deepEqual(events(seq('a', 'b'), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 a', '3/2 1/2 b']);
  assert.deepEqual(events(fastcat('a')), ['0 1 a']);
  assert.deepEqual(events(fastcat()), []);
});

test('slowcat: one pattern per cycle, each counting its own cycles', () => {
  assert.deepEqual(events(slowcat('a', 'b'), 4), ['0 1 a', '1 1 b', '2 1 a', '3 1 b']);
  assert.deepEqual(events(slowcat('a', slowcat('b', 'c')), 4), ['0 1 a', '1 1 b', '2 1 a', '3 1 c']);
  assert.deepEqual(events(cat('a', fastcat('b', 'c')), 2), ['0 1 a', '1 1/2 b', '3/2 1/2 c']);
  assert.deepEqual(events(slowcat('a', 'b', 'c')._fast(2), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 c', '3/2 1/2 a']);
  assert.deepEqual(events(slowcat('a'), 2), ['0 1 a', '1 1 a']);
  assert.deepEqual(events(slowcat(), 2), []);
  // negative cycles count backwards through the list
  assert.deepEqual(events(slowcat('a', 'b', 'c'), 0, -2), ['-2 1 b', '-1 1 c']);
});

test('alternation inside a sequence advances once per cycle', () => {
  assert.deepEqual(events(fastcat('a', slowcat('b', 'c')), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 a', '3/2 1/2 c']);
  // the same pattern twice in a cycle gives the same step twice
  const alt = slowcat('a', 'b');
  assert.deepEqual(events(fastcat(alt, alt, 'c'), 2), ['0 1/3 a', '1/3 1/3 a', '2/3 1/3 c', '1 1/3 b', '4/3 1/3 b', '5/3 1/3 c']);
});

test('timecat: weighted steps', () => {
  assert.deepEqual(events(timecat([3, 'a'], [1, 'b'])), ['0 3/4 a', '3/4 1/4 b']);
  assert.deepEqual(events(timecat([2, 'a'], [1, 'b'], [1, 'c'])), ['0 1/2 a', '1/2 1/4 b', '3/4 1/4 c']);
  assert.deepEqual(events(timecat([1.5, 'a'], [1, 'b'])), ['0 3/5 a', '3/5 2/5 b']);
  assert.deepEqual(events(timecat([2, fastcat('a', 'b')], [1, 'c'])), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 c']);
  assert.deepEqual(events(timecat([0, 'a'], [1, 'b'])), ['0 1 b'], 'a weight of zero takes no time');
  assert.deepEqual(events(timecat()), []);
});

test('stack: everything at once', () => {
  assert.deepEqual(events(stack('a', fastcat('b', 'c'))), ['0 1 a', '0 1/2 b', '1/2 1/2 c']);
  assert.deepEqual(events(stack()), []);
  assert.deepEqual(events(stack('a', 'b')._fast(2)), ['0 1/2 a', '0 1/2 b', '1/2 1/2 a', '1/2 1/2 b']);
});

test('fast and slow', () => {
  assert.deepEqual(events(fastcat('a', 'b').fast(2)), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(events(fastcat('a', 'b', 'c').fast(2).fast(2)).length, 12);
  assert.deepEqual(events(pure('a').fast(1.5), 2), ['0 2/3 a', '2/3 2/3 a', '4/3 2/3 a']);
  assert.deepEqual(events(fastcat('a', 'b').slow(2), 2), ['0 1 a', '1 1 b']);
  assert.deepEqual(events(fastcat('a', 'b', 'c').slow(2), 2), ['0 2/3 a', '2/3 2/3 b', '4/3 2/3 c']);
  assert.deepEqual(events(fastcat('a', 'b').fast(2).slow(2)), ['0 1/2 a', '1/2 1/2 b']);
  assert.deepEqual(events(pure('a').fast(0), 2), [], 'fast(0) is silence');
  assert.deepEqual(events(pure('a').slow(0), 2), [], 'slow(0) is silence');
  assert.deepEqual(events(pure('a').fast(-1), 2), [], 'a negative speed is silence');
  assert.throws(() => pure('a').fast(NaN).firstCycle(), PatternError);
});

test('a slow step inside a sequence only sounds when its onset falls in the step', () => {
  // "a b/2": b lasts a whole cycle from the middle, so it only starts every other cycle
  assert.deepEqual(events(fastcat('a', pure('b').slow(2)), 2), ['0 1/2 a', '1/2 1 b', '1 1/2 a']);
  // "a [b c]/2": the sub-sequence alternates
  assert.deepEqual(events(fastcat('a', fastcat('b', 'c').slow(2)), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 a', '3/2 1/2 c']);
  // "[a b c]/2"
  assert.deepEqual(events(fastcat('a', 'b', 'c').slow(2), 4), ['0 2/3 a', '2/3 2/3 b', '4/3 2/3 c', '2 2/3 a', '8/3 2/3 b', '10/3 2/3 c']);
});

test('patterned speed: each value of the argument applies while it lasts', () => {
  assert.deepEqual(events(pure('bd').fast(slowcat(2, 3)), 2), ['0 1/2 bd', '1/2 1/2 bd', '1 1/3 bd', '4/3 1/3 bd', '5/3 1/3 bd']);
  assert.deepEqual(events(fastcat('a', 'b').fast(fastcat(1, 2))), ['0 1/2 a', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(events(pure('a').fast(fastcat(2, 3))), ['0 1/2 a', '2/3 1/3 a']);
  assert.deepEqual(events(pure('a').slow(fastcat(1, 2))), ['0 1 a']);
  assert.deepEqual(events(fastcat('a', 'b').slow(slowcat(1, 2)), 2), ['0 1/2 a', '1/2 1/2 b', '1 1 b']);
});

test('early and late', () => {
  assert.deepEqual(events(fastcat('a', 'b').late(0.25)), ['1/4 1/2 a', '3/4 1/2 b']);
  assert.deepEqual(events(fastcat('a', 'b').early(0.25)), ['1/4 1/2 b', '3/4 1/2 a']);
  assert.deepEqual(events(fastcat('a', 'b').late(slowcat(0, 0.25)), 2), ['0 1/2 a', '1/2 1/2 b', '5/4 1/2 a', '7/4 1/2 b']);
  assert.deepEqual(events(fastcat('a', 'b').late(1), 1), ['0 1/2 a', '1/2 1/2 b'], 'a whole cycle changes nothing');
  // the shifted event's tail is still in the cycle, without its onset
  assert.deepEqual(fragments(fastcat('a', 'b').late(0.25), 0, 1), ['-1/4 → 1/4 (0 → 1/4): "b"', '1/4 → 3/4: "a"', '3/4 → 5/4 (3/4 → 1): "b"']);
});

test('rev: each cycle backwards', () => {
  assert.deepEqual(events(fastcat('a', 'b', 'c').rev()), ['0 1/3 c', '1/3 1/3 b', '2/3 1/3 a']);
  assert.deepEqual(events(fastcat('a', fastcat('b', 'c')).rev()), ['0 1/4 c', '1/4 1/4 b', '1/2 1/2 a']);
  assert.deepEqual(events(fastcat('a', 'b').rev().rev(), 2), events(fastcat('a', 'b'), 2));
  assert.deepEqual(events(slowcat('a', 'b').rev(), 2), ['0 1 a', '1 1 b']);
  assert.deepEqual(events(fastcat('a', 'b', 'c', 'd').palindrome(), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 c', '3/4 1/4 d', '1 1/4 d', '5/4 1/4 c', '3/2 1/4 b', '7/4 1/4 a']);
});

test('every and lastOf', () => {
  const ab = fastcat('a', 'b');
  assert.deepEqual(events(ab.every(2, (p) => p.fast(2)), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 a', '3/4 1/4 b', '1 1/2 a', '3/2 1/2 b']);
  assert.deepEqual(events(ab.every(3, (p) => p.rev()), 3), ['0 1/2 b', '1/2 1/2 a', '1 1/2 a', '3/2 1/2 b', '2 1/2 a', '5/2 1/2 b']);
  assert.deepEqual(events(ab.every(4, (p) => p.fast(2)), 4).length, 4 + 2 + 2 + 2);
  assert.deepEqual(events(ab.every(1, (p) => p.fast(2)), 2).length, 8, 'every cycle');
  assert.deepEqual(events(ab.every(0, (p) => p.fast(2)), 2), events(ab, 2), 'never');
  assert.deepEqual(events(ab.every(slowcat(2, 3), (p) => p.fast(2)), 4).map((e) => e.split(' ')[1]),
    ['1/4', '1/4', '1/4', '1/4', '1/2', '1/2', '1/4', '1/4', '1/4', '1/4', '1/4', '1/4', '1/4', '1/4']);
  assert.deepEqual(events(ab.lastOf(2, (p) => p.fast(2)), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/4 a', '5/4 1/4 b', '3/2 1/4 a', '7/4 1/4 b']);
  assert.throws(() => ab.every(1.5, (p) => p).firstCycle(), PatternError);
});

test('struct takes the rhythm from the booleans', () => {
  assert.deepEqual(events(pure('x').struct(fastcat(true, false, true, true))), ['0 1/4 x', '1/2 1/4 x', '3/4 1/4 x']);
  assert.deepEqual(events(fastcat('a', 'b').struct(fastcat(true, false, true, true))), ['0 1/4 a', '1/2 1/4 b', '3/4 1/4 b']);
  assert.deepEqual(events(fastcat('a', 'b').struct(slowcat(fastcat(true, false), pure(true))), 2), ['0 1/2 a', '1 1 a']);
  assert.deepEqual(events(fastcat('a', 'b').mask(fastcat(true, false))), ['0 1/2 a']);
  assert.deepEqual(events(pure('x').struct(fastcat<unknown>(1, 0, 'x', 'f'))), ['0 1/4 x', '1/2 1/4 x'], 'f, false and 0 are off; anything else is on');
  assert.deepEqual(events(pure('x').struct(fastcat<unknown>('t', 'false', 'true', '0'))), ['0 1/4 x', '1/2 1/4 x']);
});

test('Bjorklund spreads hits as evenly as it can', () => {
  const draw = (k: number, n: number) => bjorklund(k, n).map((b) => (b ? 'x' : '.')).join('');
  assert.equal(draw(3, 8), 'x..x..x.');
  assert.equal(draw(5, 8), 'x.xx.xx.');
  assert.equal(draw(2, 5), 'x.x..');
  assert.equal(draw(3, 4), 'xxx.');
  assert.equal(draw(4, 7), 'x.x.x.x');
  assert.equal(draw(5, 16), 'x..x..x..x..x...');
  assert.equal(draw(7, 16), 'x..x.x.x..x.x.x.');
  assert.equal(draw(3, 5), 'x.x.x');
  assert.equal(draw(4, 9), 'x.x.x.x..');
  assert.equal(draw(5, 12), 'x..x.x..x.x.');
  assert.equal(draw(0, 4), '....');
  assert.equal(draw(4, 4), 'xxxx');
  assert.equal(draw(5, 4), 'xxxx', 'more hits than steps fill every step');
  assert.equal(draw(1, 4), 'x...');
  assert.equal(draw(2, 0), '');
  assert.throws(() => bjorklund(1.5, 4), PatternError);
});

test('euclid: hits on the Bjorklund steps, rotated later, inverted when negative', () => {
  assert.deepEqual(events(pure('x').euclid(3, 8)), ['0 1/8 x', '3/8 1/8 x', '3/4 1/8 x']);
  assert.deepEqual(events(fastcat('a', 'b', 'c').euclid(3, 8)), ['0 1/8 a', '3/8 1/8 b', '3/4 1/8 c']);
  assert.equal(bools(euclidBools(3, 8, 2)), 'x.x..x..');
  assert.equal(bools(euclidBools(3, 8, 1)), '.x..x..x');
  assert.equal(bools(euclidBools(3, 8, -1)), '..x..x.x');
  assert.equal(bools(euclidBools(5, 8, 3)), 'xx.x.xx.');
  assert.equal(bools(euclidBools(-3, 8)), '.xx.xx.x');
  assert.deepEqual(events(pure('a').euclid(slowcat(3, 5), 8), 2).length, 8);
  assert.deepEqual(events(pure('a').euclid(fastcat(3, 5), 8)), ['0 1/8 a', '3/8 1/8 a', '5/8 1/8 a', '3/4 1/8 a']);
  assert.deepEqual(events(pure('a').euclid(3, 8, slowcat(0, 2)), 2), ['0 1/8 a', '3/8 1/8 a', '3/4 1/8 a', '1 1/8 a', '5/4 1/8 a', '13/8 1/8 a']);
  assert.deepEqual(events(pure('a').euclid(3, 0)), []);
  assert.throws(() => pure('a').euclid(3, 8, 0.5).firstCycle(), PatternError);
});

test('ply repeats each event in its own span', () => {
  assert.deepEqual(events(fastcat('a', 'b').ply(2)), ['0 1/4 a', '1/4 1/4 a', '1/2 1/4 b', '3/4 1/4 b']);
  assert.deepEqual(events(pure('a').ply(fastcat(2, 3))), ['0 1/2 a', '2/3 1/3 a']);
  assert.deepEqual(events(fastcat('a', 'b').ply(slowcat(1, 2)), 2), ['0 1/2 a', '1/2 1/2 b', '1 1/4 a', '5/4 1/4 a', '3/2 1/4 b', '7/4 1/4 b']);
  assert.deepEqual(events(pure('a').ply(1.5), 2), ['0 2/3 a', '2/3 1/3 a', '1 2/3 a', '5/3 1/3 a']);
});

test('off adds a shifted, transformed copy', () => {
  const shout = (p: Pattern<string>) => p.fmap((v) => v.toUpperCase());
  assert.deepEqual(events(fastcat('a', 'b').off(0.125, shout)), ['0 1/2 a', '1/8 1/2 A', '1/2 1/2 b', '5/8 1/2 B']);
  assert.deepEqual(events(pure('a').off(slowcat(0.125, 0.25), shout), 2), ['0 1 a', '1/8 1 A', '1 1 a', '5/4 1 A']);
  assert.deepEqual(events(fastcat('a', 'b').superimpose((p) => p.fast(2))), ['0 1/2 a', '0 1/4 a', '1/4 1/4 b', '1/2 1/2 b', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(events(fastcat('a', 'b').layer((p) => p.rev(), (p) => p.fast(2))), ['0 1/2 b', '0 1/4 a', '1/4 1/4 b', '1/2 1/2 a', '1/2 1/4 a', '3/4 1/4 b']);
});

test('iter starts each cycle one step further on', () => {
  assert.deepEqual(events(fastcat('a', 'b', 'c', 'd').iter(4), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 c', '3/4 1/4 d', '1 1/4 b', '5/4 1/4 c', '3/2 1/4 d', '7/4 1/4 a']);
  assert.deepEqual(events(fastcat('a', 'b', 'c', 'd').iter(2), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 c', '3/4 1/4 d', '1 1/4 c', '5/4 1/4 d', '3/2 1/4 a', '7/4 1/4 b']);
  assert.deepEqual(events(fastcat('a', 'b', 'c', 'd').iter(4, true), 2, 1), ['1 1/4 d', '5/4 1/4 a', '3/2 1/4 b', '7/4 1/4 c']);
  assert.deepEqual(events(fastcat('a', 'b', 'c').iter(4), 2, 1), ['13/12 1/3 b', '17/12 1/3 c', '7/4 1/3 a']);
  assert.throws(() => pure('a').iter(0), PatternError);
});

test('polymeter: every sequence steps at the same rate', () => {
  assert.deepEqual(events(polymeter([['a', 'b', 'c'], ['d', 'e']]), 2),
    ['0 1/3 a', '0 1/3 d', '1/3 1/3 b', '1/3 1/3 e', '2/3 1/3 c', '2/3 1/3 d', '1 1/3 a', '1 1/3 e', '4/3 1/3 b', '4/3 1/3 d', '5/3 1/3 c', '5/3 1/3 e']);
  assert.deepEqual(events(polymeter([['a', 'b', 'c']], 4), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 c', '3/4 1/4 a', '1 1/4 b', '5/4 1/4 c', '3/2 1/4 a', '7/4 1/4 b']);
  assert.deepEqual(events(polymeter([['a', 'b']], 4)), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(events(polymeter([[], ['a']])), ['0 1 a']);
  assert.deepEqual(events(polymeter([])), []);
});

test('degradeBy drops a seeded share of the events; the seed changes which', () => {
  const hats = pure('h').fast(8);
  const kept = events(hats.degradeBy(0.5));
  assert.ok(kept.length >= 2 && kept.length <= 6, `${kept.length} of 8 kept`);
  assert.deepEqual(events(hats.degradeBy(0.5)), kept, 'deterministic');
  assert.deepEqual(events(hats.degradeBy(0)), events(hats));
  assert.deepEqual(events(hats.degradeBy(1)), []);
  assert.notDeepEqual(events(hats.degradeBy(0.5, 1)), kept, 'another seed, another choice');
  // degradeBy and undegradeBy are complementary
  const dropped = events(hats._undegradeBy(0.5));
  assert.deepEqual([...kept, ...dropped].sort(), events(hats).sort());
  assert.deepEqual(events(hats.degrade()), kept);
  // over many events the share is about right
  const many = events(pure('h').fast(1000).degradeBy(0.3), 1, 0);
  assert.ok(many.length > 620 && many.length < 780, `${many.length} of 1000 kept at p=0.3`);
  // a patterned probability
  assert.deepEqual(events(hats.degradeBy(slowcat(0, 1)), 2), events(hats));
});

test('sometimesBy applies f to the share it would drop', () => {
  const hats = pure('h').fast(8);
  const shout = (p: Pattern<string>) => p.fmap((v) => v.toUpperCase());
  const mixed = events(hats.sometimesBy(0.25, shout));
  assert.equal(mixed.length, 8);
  assert.equal(mixed.filter((e) => e.endsWith('H')).length, 8 - events(hats.degradeBy(0.25)).length);
  assert.deepEqual(events(hats.sometimes(shout)).filter((e) => e.endsWith('h')), events(hats.degradeBy(0.5)));
  assert.deepEqual(events(hats.always(shout)), events(shout(hats)));
  assert.deepEqual(events(hats.never()), events(hats));
  assert.ok(events(hats.often(shout)).filter((e) => e.endsWith('H')).length > events(hats.rarely(shout)).filter((e) => e.endsWith('H')).length);
  // f may change the timing: fast(2) on the chosen events
  const ab = fastcat('a', 'b');
  const some = ab.sometimesBy(0.3, (p) => p.fast(2));
  assert.deepEqual(events(some, 4), events(some, 4));
  // whole cycles at a time
  const perCycle = ab.someCyclesBy(0.5, shout);
  const changed = Array.from({ length: 12 }, (_, c) => perCycle.firstCycle === undefined ? [] : perCycle.onsetsOnly().queryArc(c, c + 1).map((h) => h.value === h.value.toUpperCase()));
  for (const cycle of changed) assert.ok(cycle.length === 2 && (cycle.every(Boolean) || !cycle.some(Boolean)), JSON.stringify(cycle));
  assert.ok(changed.some((c) => c[0]) && changed.some((c) => !c[0]), 'some cycles changed, some not');
});

test('randcat and choose pick per cycle, seeded', () => {
  const picks = events(randcat(['a', 'b', 'c']), 12).map((e) => e.split(' ')[2]);
  assert.equal(picks.length, 12);
  assert.ok(new Set(picks).size > 1, 'not always the same');
  assert.deepEqual(events(randcat(['a', 'b', 'c']), 12).map((e) => e.split(' ')[2]), picks);
  assert.deepEqual(events(randcat([fastcat('a', 'a'), fastcat('b', 'b', 'b')]), 4).length >= 8, true);
  assert.deepEqual(events(randcat([]), 2), []);
  assert.deepEqual(events(choose(['x', 'y']), 6).map((e) => e.split(' ')[2]), events(randcat(['x', 'y']), 6).map((e) => e.split(' ')[2]));
});

test('signals are sampled in the middle of the query, with no onset', () => {
  const [h] = saw.queryArc(0, 0.5);
  assert.equal(h.whole, undefined);
  assert.equal(h.value, 0.25);
  assert.equal(sine.queryArc(0, 0.5)[0].value, 1, 'sine peaks at a quarter cycle');
  assert.equal(signal((t) => Number(t) * 2).queryArc(1, 2)[0].value, 3);
  assert.equal(events(saw, 4).length, 0, 'signals have no onsets');
  const r = rand().queryArc(0, 1)[0].value;
  assert.ok(r >= 0 && r < 1);
  assert.equal(rand().queryArc(0, 1)[0].value, r);
  // a signal gives each event the value at the middle of its whole
  assert.deepEqual(fastcat('a', 'b').appLeft(saw, (v, x) => `${v}${x}`).firstCycle().map((h) => h.value), ['a0.25', 'b0.75']);
});

test('appLeft keeps the left structure; appBoth needs both', () => {
  const ab = fastcat('a', 'b');
  assert.deepEqual(events(ab.appLeft(slowcat(1, 2), (a, n) => a + n), 2), ['0 1/2 a1', '1/2 1/2 b1', '1 1/2 a2', '3/2 1/2 b2']);
  assert.deepEqual(events(ab.appLeft(fastcat(1, 2, 3), (a, n) => a + n)), ['0 1/2 a1', '1/2 1/2 b2']);
  assert.deepEqual(fragments(ab.appLeft(fastcat(1, 2, 3), (a, n) => a + n), 0, 1),
    ['0 → 1/2 (0 → 1/3): "a1"', '0 → 1/2 (1/3 → 1/2): "a2"', '1/2 → 1 (1/2 → 2/3): "b2"', '1/2 → 1 (2/3 → 1): "b3"']);
  assert.deepEqual(events(pure('a').appLeft(fastcat(1, 2), (a, n) => a + n)), ['0 1 a1'], 'only the first fragment has the onset');
  assert.deepEqual(events(ab.appBoth(fastcat(1, 2, 3), (a, n) => a + n)), ['0 1/3 a1', '1/3 1/6 a2', '1/2 1/6 b2', '2/3 1/3 b3']);
});

test('joins', () => {
  const outer = fastcat(pure(fastcat('a', 'b')), pure(slowcat('c', 'd')));
  // inner patterns keep their own timeline: "a b" shows its first half, "<c d>" has no onset in the second half
  assert.deepEqual(events(outer.innerJoin(), 2), ['0 1/2 a', '1 1/2 a']);
  assert.deepEqual(fragments(outer.innerJoin(), 0, 1), ['0 → 1/2: "a"', '0 → 1 (1/2 → 1): "c"']);
  assert.deepEqual(events(outer.outerJoin(), 2), ['0 1/2 a', '1/2 1/2 c', '1 1/2 a', '3/2 1/2 d'], 'the value at each onset');
  assert.deepEqual(events(outer.squeezeJoin(), 2), ['0 1/4 a', '1/4 1/4 b', '1/2 1/2 c', '1 1/4 a', '5/4 1/4 b', '3/2 1/2 c'], 'cycle 0 of each inner pattern, squeezed');
  assert.deepEqual(events(pure(fastcat('a', 'b')).slow(2).squeezeJoin(), 2), ['0 1 a', '1 1 b']);
  assert.deepEqual(events(patternify((n: number, p: Pattern<string>) => p.fast(n))(fastcat(1, 2), fastcat('a', 'b'))), ['0 1/2 a', '1/2 1/4 a', '3/4 1/4 b']);
});

test('compress and focus', () => {
  assert.deepEqual(events(fastcat('a', 'b').compress(0.25, 0.75)), ['1/4 1/4 a', '1/2 1/4 b']);
  assert.deepEqual(events(fastcat('a', 'b').compress(0.5, 0.25)), [], 'an empty span is silence');
  assert.deepEqual(events(fastcat('a', 'b').compress(-1, 0.5)), []);
  assert.deepEqual(events(fastcat('a', 'b').focus(new TimeSpan(0.5, 1.5)), 2), ['0 1/2 b', '1/2 1/2 a', '1 1/2 b', '3/2 1/2 a']);
  assert.deepEqual(events(pure('a').compress(0, 1), 2), ['0 1 a', '1 1 a']);
});

test('fmap, filters and onsets', () => {
  assert.deepEqual(events(fastcat(1, 2, 3).fmap((n) => n * 2)), ['0 1/3 2', '1/3 1/3 4', '2/3 1/3 6']);
  assert.deepEqual(events(fastcat(1, 2, 3).filterValues((n) => n !== 2)), ['0 1/3 1', '2/3 1/3 3']);
  assert.deepEqual(events(fastcat('a', 'b').filterHaps((h) => h.part.begin.gte(0.5))), ['1/2 1/2 b']);
  assert.equal(pure('a').queryArc(0.5, 1.5).length, 2);
  assert.equal(pure('a').onsetsOnly().queryArc(0.5, 1.5).length, 1);
  assert.equal(pure('a').firstCycle()[0].duration.valueOf(), 1);
  assert.deepEqual(pure('a').splitQueries().queryArc(0, 2).map(String), ['0 → 1: "a"', '1 → 2: "a"']);
  const h = pure('a').firstCycle()[0];
  assert.ok(h.hasOnset());
  assert.equal(String(h.setValue('b')), '0 → 1: "b"');
  assert.equal(String(h.withSpan((s) => s.withTime((t) => t.add(1)))), '1 → 2: "a"');
});

test('the budget stops runaway queries with a clear error', () => {
  const huge = pure('h').fast(1e6);
  assert.throws(() => huge.queryArc(0, 1), /too many events/);
  assert.throws(() => huge.queryArc(0, 1, { maxEvents: 100 }), /more than 100/);
  assert.equal(pure('h').fast(50).queryArc(0, 1, { maxEvents: 100 }).length, 50);
  assert.throws(() => pure('h').fast(50).queryArc(0, 1, { maxEvents: 10 }), PatternError);
  // stacked layers count together
  assert.throws(() => stack(...Array.from({ length: 30 }, () => pure('a').fast(100))).queryArc(0, 1, { maxEvents: 1000 }), /too many/);
  // time: two sides that stay within the event limit but meet 10k × 10k
  // times inside appBoth, where no events are made for a long while
  const dense = pure('a').fast(10000);
  const started = performance.now();
  assert.throws(() => dense.appBoth(dense, (x, y) => x + y).queryArc(0, 1, { maxEvents: 1e9, maxMillis: 100 }), /too long/);
  assert.ok(performance.now() - started < 1000, `stopped after ${(performance.now() - started).toFixed(0)} ms`);
  // time: a pattern whose every query is slow
  const slow = new Pattern((span, b) => { const end = performance.now() + 5; while (performance.now() < end) { /* busy */ } return pure('a').query(span, b); });
  assert.throws(() => stack(...Array.from({ length: 20 }, () => slow)).queryArc(0, 1, { maxMillis: 20 }), /too long/);
});

test('zero-width queries find the event under a point in time', () => {
  assert.deepEqual(fastcat('a', 'b').queryArc(0.5, 0.5).map(String), ['1/2 → 1 (1/2 → 1/2): "b"']);
  assert.deepEqual(fastcat('a', 'b').queryArc(0.25, 0.25).map(String), ['0 → 1/2 (1/4 → 1/4): "a"']);
  assert.deepEqual(slowcat('a', 'b').queryArc(1, 1).map(String), ['1 → 2 (1 → 1): "b"']);
});

test('a Fraction can be used wherever a time is wanted', () => {
  assert.deepEqual(events(fastcat('a', 'b').late(new Fraction(1, 4))), ['1/4 1/2 a', '3/4 1/2 b']);
  assert.deepEqual(events(pure('a').fast(new Fraction(3, 2)), 2), ['0 2/3 a', '2/3 2/3 a', '4/3 2/3 a']);
  assert.deepEqual(events(pure('a').fast(Fraction.from('3/2')), 2), ['0 2/3 a', '2/3 2/3 a', '4/3 2/3 a']);
});
