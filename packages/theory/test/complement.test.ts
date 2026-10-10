import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complements, pc, scalePitchClasses, type Key } from '../src/index.ts';

const C: Key = { tonic: 0, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };

test('C and E: G completes C, A completes Am', () => {
  const found = complements([60, 64], C);
  assert.equal(found[0].pitch, 67);
  assert.equal(found[0].reason, 'completes C');
  assert.equal(found[1].pitch, 69);
  assert.equal(found[1].reason, 'completes Am');
});

test('a C triad gets its 7th, 9th or 6th', () => {
  const found = complements([60, 64, 67], C);
  assert.ok([71, 69].includes(found[0].pitch), `${found[0].pitch}`);
  const reasons = found.map(f => f.reason).join(', ');
  assert.match(reasons, /adds the 7th \(Cmaj7\)/);
  assert.match(reasons, /adds the 6th \(C6\)/);
  assert.match(reasons, /adds the 9th \(Cadd9\)/);
});

test('a G triad in C gets the F that makes G7', () => {
  const [first] = complements([55, 59, 62], C);
  assert.equal(first.pitch, 65);
  assert.equal(first.reason, 'adds the 7th (G7)');
});

test('a 7th chord gets its 9th', () => {
  const [first] = complements([57, 60, 64, 67], C);
  assert.equal(pc(first.pitch), 11);
  assert.match(first.reason, /9th \(Am9\)/);
});

test('one note gets harmonies a 3rd and a 6th away', () => {
  const found = complements([64], C);
  assert.ok([67, 72].includes(found[0].pitch) && [67, 72].includes(found[1].pitch));
  assert.deepEqual(found.map(f => f.pitch).sort((a, b) => a - b), [55, 60, 67, 72]);
  // In A minor, a C gets E above (a 3rd) and A below
  const minor = complements([72], A_MINOR);
  assert.equal(minor[0].pitch, 76);
  assert.ok(minor.some(f => f.pitch === 69));
});

test('a power chord gets its 3rd', () => {
  assert.equal(complements([60, 67], C)[0].pitch, 64);
  assert.equal(complements([57, 64], A_MINOR)[0].pitch, 60);
});

test('notes no chord of the key holds are still completed', () => {
  const [first] = complements([60, 63], C);
  assert.equal(first.pitch, 67);
  assert.equal(first.reason, 'completes Cm');
});

test('suggestions sit near the held notes, in the key, weights summing to 1', () => {
  const helds = [[60], [64], [60, 64], [62, 65], [60, 64, 67], [55, 59, 62, 65], [48, 52], [71, 74]];
  for (const key of [C, A_MINOR]) {
    for (const held of helds) {
      const found = complements(held, key);
      assert.ok(found.length > 0, held.join(' '));
      assert.ok(Math.abs(found.reduce((s, f) => s + f.weight, 0) - 1) < 1e-9);
      for (const f of found) {
        assert.ok(f.pitch >= Math.min(...held) - 12 && f.pitch <= Math.max(...held) + 12, `${held.join(' ')}: ${f.pitch}`);
        assert.ok(!held.map(pc).includes(pc(f.pitch)), `${held.join(' ')}: ${f.pitch} is held`);
      }
      // The best suggestion is in the key (or the minor key's raised 7th)
      assert.ok([...scalePitchClasses(key), pc(key.tonic + 11)].includes(pc(found[0].pitch)), `${held.join(' ')}: ${found[0].pitch}`);
    }
  }
  assert.deepEqual(complements([], C), []);
});
