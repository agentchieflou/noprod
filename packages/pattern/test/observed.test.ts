import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mini } from '../src/index.ts';

// Fixtures observed from the engine dictation ran on until #133: a headless
// page loading the published @strudel/web bundle (its behavior, not its
// source), evaluating s("...") and listing queryArc(0, cycles) onsets as
// "begin+duration". These pin the engine to what dictated code has always
// played, where the documentation leaves room (the direction of the
// Euclidean rotation most of all: Tidal's text says left, the engine goes
// right, so a(3,8,2) is x..x..x. moved two steps later: steps 0, 2, 5).
const OBSERVED: [string, number, string[]][] = [
  ['a(3,8)', 2, ['0+1/8', '3/8+1/8', '3/4+1/8', '1+1/8', '11/8+1/8', '7/4+1/8']],
  ['a(3,8,2)', 2, ['0+1/8', '1/4+1/8', '5/8+1/8', '1+1/8', '5/4+1/8', '13/8+1/8']],
  ['a(3,8,1)', 2, ['1/8+1/8', '1/2+1/8', '7/8+1/8', '9/8+1/8', '3/2+1/8', '15/8+1/8']],
  ['a(3,8,-1)', 2, ['1/4+1/8', '5/8+1/8', '7/8+1/8', '5/4+1/8', '13/8+1/8', '15/8+1/8']],
  ['a(5,8,3)', 2, ['0+1/8', '1/8+1/8', '3/8+1/8', '5/8+1/8', '3/4+1/8', '1+1/8', '9/8+1/8', '11/8+1/8', '13/8+1/8', '7/4+1/8']],
  ['a(<3 5>,8)', 2, ['0+1/8', '3/8+1/8', '3/4+1/8', '1+1/8', '5/4+1/8', '11/8+1/8', '13/8+1/8', '7/4+1/8']],
  ['a(3,8,<0 2>)', 2, ['0+1/8', '3/8+1/8', '3/4+1/8', '1+1/8', '5/4+1/8', '13/8+1/8']],
  ['a(-3,8)', 1, ['1/8+1/8', '1/4+1/8', '1/2+1/8', '5/8+1/8', '7/8+1/8']],
  ['a(3,4)', 1, ['0+1/4', '1/4+1/4', '1/2+1/4']],
  ['a(5,6)', 1, ['0+1/6', '1/6+1/6', '1/3+1/6', '1/2+1/6', '2/3+1/6']],
  ['<a <b c>>', 4, ['0+1', '1+1', '2+1', '3+1']],
  ['<a b>!2 c', 2, ['0+1/3', '1/3+1/3', '2/3+1/3', '1+1/3', '4/3+1/3', '5/3+1/3']],
  ['a b/2', 2, ['0+1/2', '1/2+1', '1+1/2']],
  ['a [b c]/2', 2, ['0+1/2', '1/2+1/2', '1+1/2', '3/2+1/2']],
  ['bd*<2 3>', 2, ['0+1/2', '1/2+1/2', '1+1/3', '4/3+1/3', '5/3+1/3']],
  ['a*[2 3]', 1, ['0+1/2', '2/3+1/3']],
  ['a/[1 2]', 2, ['0+1', '1+1']],
  ['a@1.5 b', 1, ['0+3/5', '3/5+2/5']],
  ['a!0 b', 1, ['1/2+1/2']],
  ['{a b c, d e}%4', 1, ['0+1/4', '0+1/4', '1/4+1/4', '1/4+1/4', '1/2+1/4', '1/2+1/4', '3/4+1/4', '3/4+1/4']],
  ['{a b c}%<2 4>', 2, ['0+1/2', '1/2+1/2', '1+1/4', '5/4+1/4', '3/2+1/4', '7/4+1/4']],
  ['0 .. 2 5', 1, ['0+1/4', '1/4+1/4', '1/2+1/4', '3/4+1/4']],
  ['a b . c d e . f', 1, ['0+1/6', '1/6+1/6', '1/3+1/9', '4/9+1/9', '5/9+1/9', '2/3+1/3']]
];

for (const [source, cycles, onsets] of OBSERVED) {
  test(`observed: "${source}" over ${cycles} cycle${cycles > 1 ? 's' : ''}`, () => {
    const got = mini(source).onsetsOnly().queryArc(0, cycles).map((h) => `${h.whole!.begin}+${h.whole!.duration}`);
    assert.deepEqual(got, onsets);
  });
}

// The values the observed sequencer gave for these, too
test('observed values: "<a <b c>>" plays a b a c; "<a b>!2 c" plays a a c then b b c', () => {
  assert.deepEqual(mini('<a <b c>>').firstCycle().map((h) => h.value).concat(mini('<a <b c>>').onsetsOnly().queryArc(1, 4).map((h) => h.value)), ['a', 'b', 'a', 'c']);
  assert.deepEqual(mini('<a b>!2 c').onsetsOnly().queryArc(0, 2).map((h) => h.value), ['a', 'a', 'c', 'b', 'b', 'c']);
  assert.deepEqual(mini('{a b c, d e}%4').onsetsOnly().queryArc(1, 2).map((h) => h.value), ['b', 'd', 'c', 'e', 'a', 'd', 'b', 'e']);
});
