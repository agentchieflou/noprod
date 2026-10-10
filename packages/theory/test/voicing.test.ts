import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHORD_QUALITIES, chordPitches, chordTones, movement, pc, voiceLead, type ChordQuality } from '../src/index.ts';

test('C to F keeps the common tone and moves the others by steps', () => {
  assert.deepEqual(voiceLead([60, 64, 67], 5, 'maj'), [60, 65, 69]);
  assert.equal(movement([60, 64, 67], [60, 65, 69]), 3);
});

test('G7 to C resolves by steps', () => {
  const c = voiceLead([55, 59, 62, 65], 0, 'maj');
  assert.ok(movement([55, 59, 62, 65], c) <= 5, c.join(' '));
  assert.ok(c.includes(55) || c.includes(67), 'G stays');
});

test('with nothing before, root position around middle C', () => {
  assert.deepEqual(voiceLead([], 0, 'maj'), [60, 64, 67]);
  assert.deepEqual(voiceLead([], 7, '7'), chordPitches(7, '7', 60));
  assert.deepEqual(voiceLead([], 9, 'min'), [57, 60, 64]);
});

// Every chord type from a few starting voicings, onto every root
const starts = [[60, 64, 67], [48, 55, 64, 70], [62, 65, 69, 72], [59, 62, 67], [70, 74, 77]];
const cases = starts.flatMap(from =>
  CHORD_QUALITIES.flatMap(quality => Array.from({ length: 12 }, (_, root) => ({ from, root, quality: quality as ChordQuality }))));

test('each chord tone sounds exactly once, inside the range', () => {
  for (const { from, root, quality } of cases) {
    for (const range of [[48, 84], [55, 79]] as [number, number][]) {
      const voicing = voiceLead(from, root, quality, range);
      const label = `${quality} on ${root} from ${from.join(' ')}`;
      assert.deepEqual(voicing.map(pc).sort((a, b) => a - b), chordTones(root, quality).sort((a, b) => a - b), label);
      assert.deepEqual(voicing, [...voicing].sort((a, b) => a - b), label);
      for (const p of voicing) assert.ok(p >= range[0] && p <= range[1], `${label}: ${p}`);
    }
  }
});

test('the movement is never more than from root position', () => {
  for (const { from, root, quality } of cases) {
    const voicing = voiceLead(from, root, quality);
    for (const around of [48, 60, 72]) {
      const plain = chordPitches(root, quality, around);
      if (plain.some(p => p < 48 || p > 84)) continue;
      assert.ok(movement(from, voicing) <= movement(from, plain), `${quality} on ${root} from ${from.join(' ')}`);
    }
  }
});

test('voicings stay hand-sized', () => {
  for (const { from, root, quality } of cases) {
    const voicing = voiceLead(from, root, quality);
    assert.ok(voicing[voicing.length - 1] - voicing[0] <= 24);
  }
});

test('a voicing from outside the range is brought into it', () => {
  const voicing = voiceLead([24, 28, 31], 7, 'maj');
  assert.equal(voicing.length, 3);
  for (const p of voicing) assert.ok(p >= 48 && p <= 84);
});

test('movement pairs voices in order, and splits or merges when the counts differ', () => {
  assert.equal(movement([60, 64, 67], [60, 64, 67]), 0);
  assert.equal(movement([60, 64, 67], [59, 62, 67]), 3);
  assert.equal(movement([60, 67], [60, 64, 67]), 3);
  assert.equal(movement([], [60]), 0);
});
