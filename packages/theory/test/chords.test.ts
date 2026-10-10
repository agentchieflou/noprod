import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_QUALITIES, CHORD_TYPES, chordName, chordPitches, degreeOf, keyName, noteName, parseNumeral, pc,
  recognizeChord, romanNumeral, scalePitchClasses, spellInKey, usesFlats, type ChordQuality, type Key
} from '../src/index.ts';

const C: Key = { tonic: 0, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };

test('notes are named with their octave, middle C being C4', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(63, true), 'Eb4');
  assert.equal(noteName(59), 'B3');
  assert.equal(noteName(21), 'A0');
  assert.equal(pc(-1), 11);
});

test('keys are named and spelled the way they are written', () => {
  assert.equal(keyName(C), 'C major');
  assert.equal(keyName({ tonic: 6, mode: 'minor' }), 'F# minor');
  assert.equal(keyName({ tonic: 10, mode: 'major' }), 'Bb major');
  assert.equal(keyName({ tonic: 3, mode: 'minor' }), 'Eb minor');
  assert.equal(usesFlats({ tonic: 5, mode: 'major' }), true);
  assert.equal(usesFlats({ tonic: 7, mode: 'major' }), false);
  assert.deepEqual(scalePitchClasses(A_MINOR), [9, 11, 0, 2, 4, 5, 7]);
  assert.equal(degreeOf(C, 67), 4);
  assert.equal(degreeOf(C, 61), null);
  // Lowered notes take flats, raised ones sharps
  assert.equal(spellInKey(10, C), 'Bb');
  assert.equal(spellInKey(6, C), 'F#');
  assert.equal(spellInKey(8, A_MINOR), 'G#');
  assert.equal(spellInKey(10, { tonic: 5, mode: 'major' }), 'Bb');
  assert.equal(spellInKey(6, { tonic: 7, mode: 'major' }), 'F#');
});

// Voicings of a chord on `root` (a MIDI pitch): with the given chord tone
// in the bass, the rest stacked above it, the bass and the root doubled
function inversion(root: number, quality: ChordQuality, bassIndex: number) {
  const intervals = CHORD_TYPES[quality].intervals;
  const order = [...intervals.slice(bassIndex), ...intervals.slice(0, bassIndex)];
  const pitches: number[] = [];
  for (const i of order) {
    let p = root + (i % 12);
    while (pitches.length && p <= pitches[pitches.length - 1]) p += 12;
    pitches.push(p);
  }
  return [pitches[0] - 12, ...pitches, root + 24];
}

// Root in the bass, the rest spread out and doubled
const openVoicings = (root: number, quality: ChordQuality) => {
  const upper = CHORD_TYPES[quality].intervals.slice(1);
  return [
    [root - 12, root, ...upper.map(i => root + 12 + (i % 12))],
    [root, ...upper.map(i => root + i), ...upper.map(i => root + 12 + i)]
  ];
};

// Chords that read as another chord when inverted (C6/E is Am7/E, an
// augmented or diminished 7th chord is the same from every note) are
// tested with their root in the bass
const INVERSIONS: Partial<Record<ChordQuality, number[]>> = {
  maj: [1, 2], min: [1, 2], dim: [1, 2], '7': [1, 3], maj7: [1, 2], m7: [2, 3], m7b5: [2, 3],
  add9: [1, 2], '9': [1, 3], m9: [1, 2], maj9: [1, 2], '5': [1]
};

test('every chord type is recognized in root position and other voicings, doublings included', () => {
  for (const root of [60, 57, 63]) {
    for (const quality of CHORD_QUALITIES) {
      const r = pc(root);
      const rootPosition = recognizeChord(chordPitches(r, quality, root));
      assert.equal(rootPosition?.quality, quality, `${quality} on ${root} in root position`);
      assert.equal(rootPosition.root, r);
      assert.equal(rootPosition.bass, r);
      assert.equal(rootPosition.confidence, 1);
      assert.equal(rootPosition.name, chordName(r, quality));

      const voicings = [
        ...(INVERSIONS[quality] ?? []).map(k => inversion(root, quality, k)),
        ...openVoicings(root, quality)
      ];
      for (const voicing of voicings) {
        const chord = recognizeChord(voicing);
        const label = `${quality} on ${root} as ${voicing.join(' ')}`;
        assert.equal(chord?.quality, quality, label);
        assert.equal(chord.root, r, label);
        assert.equal(chord.bass, pc(Math.min(...voicing)), label);
        assert.equal(chord.name, chordName(r, quality, chord.bass), label);
      }
    }
  }
});

test('chords are named like lead sheets', () => {
  assert.equal(recognizeChord([60, 64, 67])?.name, 'C');
  assert.equal(recognizeChord([48, 60, 64, 67, 72])?.name, 'C');
  assert.equal(recognizeChord([60, 64, 69])?.name, 'Am/C');
  assert.equal(recognizeChord([59, 62, 65, 67])?.name, 'G7/B');
  assert.equal(recognizeChord([59, 62, 65, 69])?.name, 'Bm7b5');
  assert.equal(recognizeChord([60, 65, 67])?.name, 'Csus4');
  assert.equal(recognizeChord([57, 60, 64, 67])?.name, 'Am7');
  assert.equal(recognizeChord([60, 64, 67, 69])?.name, 'C6');
  assert.equal(recognizeChord([58, 62, 65])?.name, 'Bb');
  assert.equal(recognizeChord([60, 63, 66, 69])?.name, 'C°7');
  assert.equal(recognizeChord([60, 64, 68])?.name, 'C+');
  assert.equal(recognizeChord([62, 66, 69], C)?.name, 'D');
  assert.equal(recognizeChord([63, 66, 69], { tonic: 4, mode: 'major' })?.name, 'D#°');
  assert.equal(recognizeChord([66, 69, 74], { tonic: 2, mode: 'major' })?.name, 'D/F#');
});

test('a single note is not a chord; two notes are a power chord or a guess', () => {
  assert.equal(recognizeChord([]), null);
  assert.equal(recognizeChord([60]), null);
  assert.equal(recognizeChord([60, 72, 84]), null);
  assert.equal(recognizeChord([60, 67])?.name, 'C5');
  assert.equal(recognizeChord([55, 60])?.name, 'C5/G');
  const third = recognizeChord([60, 64]);
  assert.equal(third?.name, 'C');
  assert.ok(third.confidence < 0.5);
  assert.equal(recognizeChord([60, 63])?.name, 'Cm');
  assert.equal(recognizeChord([60, 62]), null);
  assert.equal(recognizeChord([60, 61]), null);
});

test('a chord missing a note is still found, with less confidence', () => {
  const noFifth = recognizeChord([60, 64, 70]);
  assert.equal(noFifth?.name, 'C7');
  assert.ok(noFifth.confidence < 1 && noFifth.confidence > 0.5);
});

test('Roman numerals: case for major and minor, accidentals for borrowed roots', () => {
  assert.equal(romanNumeral(0, 'maj', C), 'I');
  assert.equal(romanNumeral(9, 'min', C), 'vi');
  assert.equal(romanNumeral(7, '7', C), 'V7');
  assert.equal(romanNumeral(2, 'm7', C), 'ii7');
  assert.equal(romanNumeral(0, 'maj7', C), 'Imaj7');
  assert.equal(romanNumeral(11, 'dim', C), 'vii°');
  assert.equal(romanNumeral(11, 'm7b5', C), 'viiø7');
  assert.equal(romanNumeral(10, 'maj', C), 'bVII');
  assert.equal(romanNumeral(8, 'maj', C), 'bVI');
  assert.equal(romanNumeral(5, 'min', C), 'iv');
  assert.equal(romanNumeral(11, 'dim', A_MINOR), 'ii°');
  assert.equal(romanNumeral(9, 'min', A_MINOR), 'i');
  assert.equal(romanNumeral(5, 'maj', A_MINOR), 'VI');
  assert.equal(romanNumeral(7, 'maj', A_MINOR), 'VII');
  assert.equal(romanNumeral(4, 'maj', A_MINOR), 'V');
  assert.equal(romanNumeral(8, 'dim', A_MINOR), 'vii°');
});

test('Roman numerals read back to the same chords', () => {
  const numerals = {
    major: ['I', 'ii7', 'iii', 'IV', 'V7', 'vi', 'vii°', 'viiø7', 'bVII', 'bVI', 'bIII', 'iv', 'Imaj7', 'II', 'v'],
    minor: ['i', 'ii°', 'iiø7', 'III', 'iv', 'v', 'V', 'V7', 'VI', 'VII', 'vii°', 'vii°7', 'i7', 'IV', 'bII']
  };
  for (const key of [C, A_MINOR, { tonic: 3, mode: 'major' } as Key, { tonic: 6, mode: 'minor' } as Key]) {
    for (const numeral of numerals[key.mode]) {
      const { root, quality } = parseNumeral(numeral, key);
      assert.equal(romanNumeral(root, quality, key), numeral, `${numeral} in ${keyName(key)}`);
    }
  }
  assert.deepEqual(parseNumeral('V7', A_MINOR), { root: 4, quality: '7' });
  assert.deepEqual(parseNumeral('vii°', A_MINOR), { root: 8, quality: 'dim' });
  assert.deepEqual(parseNumeral('VII', A_MINOR), { root: 7, quality: 'maj' });
});

test('chord pitches are root position around a given note', () => {
  assert.deepEqual(chordPitches(0, 'maj'), [60, 64, 67]);
  assert.deepEqual(chordPitches(9, 'min'), [57, 60, 64]);
  assert.deepEqual(chordPitches(0, 'add9'), [60, 64, 67, 74]);
  assert.deepEqual(chordPitches(7, '7', 72), [67, 71, 74, 77]);
});
