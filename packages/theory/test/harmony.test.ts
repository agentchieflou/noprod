import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESSIONS, SEVENTHS, chordFamily, diatonicChords, nextChords, parseNumeral, romanNumeral, type ChordRef, type Key
} from '../src/index.ts';

const C: Key = { tonic: 0, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };
const chords = (key: Key, ...numerals: string[]) => numerals.map(n => parseNumeral(n, key));
const names = (key: Key, ...numerals: string[]) => nextChords(chords(key, ...numerals), key).map(s => s.name);

test('after C then G in C major, Am and F come first', () => {
  const top = names(C, 'I', 'V').slice(0, 2);
  assert.ok(top.includes('Am') && top.includes('F'), top.join(' '));
});

test('after Dm7 in C major, G7 comes first', () => {
  const [first] = nextChords(chords(C, 'ii7'), C);
  assert.equal(first.name, 'G7');
  assert.equal(first.roman, 'V7');
});

test('after Am, F, C in C major, G completes vi–IV–I–V', () => {
  const [first] = nextChords(chords(C, 'vi', 'IV', 'I'), C);
  assert.equal(first.name, 'G');
  assert.equal(first.roman, 'V');
  assert.match(first.reason, /vi–IV–I–V/);
});

test('7th chords lead on to 7th chords: ii7, V7, Imaj7', () => {
  assert.equal(names(C, 'ii7', 'V7')[0], 'Cmaj7');
  // ...and triads to triads
  for (const s of nextChords(chords(C, 'ii', 'V'), C)) assert.ok(!SEVENTHS.includes(s.quality), s.name);
});

test('the 12-bar blues goes to IV7 after four bars of I7', () => {
  const A: Key = { tonic: 9, mode: 'major' };
  const [first] = nextChords(chords(A, 'I7', 'I7', 'I7', 'I7'), A);
  assert.equal(first.name, 'D7');
  assert.match(first.reason, /blues/);
});

test('minor keys move by their own progressions', () => {
  assert.equal(names(A_MINOR, 'i', 'VI', 'III')[0], 'G');
  assert.equal(names(A_MINOR, 'i', 'iv', 'v')[0], 'Am');
  assert.equal(names(A_MINOR, 'iiø7', 'V7')[0], 'Am7');
});

test('the first suggestion is never the chord just played', () => {
  for (const key of [C, A_MINOR, { tonic: 2, mode: 'major' } as Key, { tonic: 4, mode: 'minor' } as Key]) {
    const all = [...diatonicChords(key), ...diatonicChords(key, true)];
    for (const a of all) {
      for (const history of [[a], ...all.map(b => [b, a])]) {
        const suggestions = nextChords(history, key, 3);
        const last = history[history.length - 1];
        for (const s of suggestions) {
          const repeat = s.root === last.root && chordFamily(s.root, s.quality, key) === chordFamily(last.root, last.quality, key);
          assert.ok(!repeat, `${s.name} after ${history.map(c => romanNumeral(c.root, c.quality, key)).join(' ')}`);
        }
      }
    }
  }
});

test('weights are sorted and sum to 1', () => {
  const histories: ChordRef[][] = [[], chords(C, 'I'), chords(C, 'I', 'V', 'vi'), chords(C, 'bVII'), chords(A_MINOR, 'i', 'VII')];
  for (const history of histories) {
    for (const count of [1, 3, 5]) {
      const suggestions = nextChords(history, C, count);
      assert.equal(suggestions.length, count);
      const sum = suggestions.reduce((s, x) => s + x.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
      for (let i = 1; i < suggestions.length; i++) assert.ok(suggestions[i - 1].weight >= suggestions[i].weight);
      for (const s of suggestions) assert.ok(s.reason.length > 0 && s.roman.length > 0);
    }
  }
});

test('with nothing played yet, the main chords of the key', () => {
  assert.deepEqual(names(C).sort(), ['C', 'F', 'G']);
});

test('every progression reads in its mode', () => {
  for (const progression of PROGRESSIONS) {
    const key = progression.mode === 'major' ? C : A_MINOR;
    for (const numeral of progression.numerals) {
      const { root, quality } = parseNumeral(numeral, key);
      assert.equal(romanNumeral(root, quality, key), numeral, progression.name);
    }
  }
});

test('suggestions are deterministic', () => {
  const history = chords(C, 'I', 'vi', 'IV');
  assert.deepEqual(nextChords(history, C), nextChords(history, C));
});
