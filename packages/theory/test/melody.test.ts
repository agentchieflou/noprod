import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MELODIES, melodyPitches, nextNotes, parseNote, pc, scalePitchClasses, type Key } from '../src/index.ts';

const C: Key = { tonic: 0, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };
const sum = (xs: { weight: number }[]) => xs.reduce((s, x) => s + x.weight, 0);

test('the corpus holds the ten public-domain tunes, in their keys', () => {
  assert.equal(MELODIES.length, 10);
  assert.equal(new Set(MELODIES.map(m => m.id)).size, 10);
  for (const melody of MELODIES) {
    const pitches = melodyPitches(melody);
    assert.ok(pitches.length >= 20, melody.name);
    // Mostly in its key: only a few notes outside it (Greensleeves' G#)
    const outside = pitches.filter(p => !scalePitchClasses(melody.key).includes(pc(p))).length;
    assert.ok(outside <= pitches.length / 5, melody.name);
    assert.equal(pc(pitches[pitches.length - 1]), melody.key.tonic, `${melody.name} ends on its tonic`);
  }
  assert.deepEqual(melodyPitches(MELODIES.find(m => m.id === 'twinkle')!).slice(0, 7), [60, 60, 67, 67, 69, 69, 67]);
  assert.equal(parseNote('Bb3'), 58);
  assert.equal(parseNote('F#5'), 78);
});

test('in C major the leading tone B4 resolves up to C5', () => {
  for (const recent of [[71], [67, 69, 71], [74, 72, 71], [60, 64, 67, 69, 71]]) {
    const [first] = nextNotes(recent, C);
    assert.equal(first.pitch, 72, recent.join(' '));
    assert.equal(first.reason, 'resolves');
    assert.ok(first.weight > 0.5, `${recent.join(' ')}: ${first.weight}`);
  }
  // Fa leans down to mi
  const fa = nextNotes([67, 65], C, null, 12);
  assert.ok(fa.find(n => n.pitch === 64)!.weight > fa.find(n => n.pitch === 67)!.weight);
});

test('after a stepwise run, steps outrank leaps', () => {
  for (const recent of [[60, 62, 64, 65], [72, 71, 69, 67], [64, 65, 67, 69]]) {
    const notes = nextNotes(recent, C, null, 6);
    const last = recent[recent.length - 1];
    const size = (p: number) => Math.abs(p - last);
    const step = notes.filter(n => size(n.pitch) >= 1 && size(n.pitch) <= 2).map(n => n.weight);
    const leap = notes.filter(n => size(n.pitch) > 2).map(n => n.weight);
    assert.ok(size(notes[0].pitch) >= 1 && size(notes[0].pitch) <= 2, `${recent.join(' ')}: ${notes[0].pitch}`);
    assert.ok(Math.max(...step) > Math.max(0, ...leap), recent.join(' '));
  }
});

test('after a leap up of a 6th, the melody steps back down', () => {
  for (const recent of [[60, 69], [65, 74], [55, 64], [57, 65]]) {
    const [first] = nextNotes(recent, C);
    const last = recent[recent.length - 1];
    assert.ok(first.pitch < last && last - first.pitch <= 2, `${recent.join(' ')}: ${first.pitch}`);
  }
  // ...and up after a leap down
  const [first] = nextNotes([72, 64], C);
  assert.ok(first.pitch > 64 && first.pitch - 64 <= 2, `${first.pitch}`);
});

test('suggestions are scale tones within an octave, weights summing to 1', () => {
  for (const [key, recent] of [[C, [60, 62, 64]], [A_MINOR, [69, 72, 76]], [A_MINOR, [68]], [C, [61]]] as [Key, number[]][]) {
    for (const count of [1, 4, 8]) {
      const notes = nextNotes(recent, key, null, count);
      assert.equal(notes.length, count);
      assert.ok(Math.abs(sum(notes) - 1) < 1e-9);
      const last = recent[recent.length - 1];
      for (const n of notes) {
        assert.ok(scalePitchClasses(key).includes(pc(n.pitch)));
        assert.ok(Math.abs(n.pitch - last) <= 12);
      }
      for (let i = 1; i < notes.length; i++) assert.ok(notes[i - 1].weight >= notes[i].weight);
    }
  }
});

test('the chord underneath favors its notes', () => {
  const plain = nextNotes([64], C, null, 15);
  const overG = nextNotes([64], C, { root: 7, quality: 'maj' }, 15);
  const weightOf = (notes: { pitch: number; weight: number }[], pitch: number) => notes.find(n => n.pitch === pitch)!.weight;
  assert.ok(weightOf(overG, 62) > weightOf(plain, 62));
  assert.ok(weightOf(overG, 67) > weightOf(plain, 67));
  assert.ok(weightOf(overG, 65) < weightOf(plain, 65));
});

test('with nothing played, the tonic triad around middle C', () => {
  assert.deepEqual(nextNotes([], C, null, 3).map(n => n.pitch).sort(), [60, 64, 67]);
  assert.deepEqual(nextNotes([], A_MINOR, null, 3).map(n => n.pitch).sort(), [57, 60, 64]);
  assert.equal(nextNotes([], C)[0].pitch, 60);
  assert.ok(Math.abs(sum(nextNotes([], C)) - 1) < 1e-9);
});

test('in A minor, the raised G# leads home to A', () => {
  assert.equal(nextNotes([71, 68], A_MINOR)[0].pitch, 69);
});
