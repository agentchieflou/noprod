// Chords: their types, names, Roman numerals, and recognizing a chord from
// the notes held on the keyboard, in any voicing.

import { nearestPitch, pc, pitchClasses, spell } from './notes.ts';
import { degreeOf, nearestDegree, scaleIntervals, scalePitchClasses, spellInKey, type Key } from './scales.ts';

export type ChordQuality =
  'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | '7' | 'maj7' | 'm7' | 'm7b5' | 'dim7' |
  '6' | 'm6' | 'add9' | '9' | 'm9' | 'maj9' | '5';

// Intervals from the root, in root position (9ths an octave above the 2nd)
export const CHORD_TYPES: Record<ChordQuality, { intervals: number[]; suffix: string; label: string }> = {
  maj: { intervals: [0, 4, 7], suffix: '', label: 'major' },
  min: { intervals: [0, 3, 7], suffix: 'm', label: 'minor' },
  dim: { intervals: [0, 3, 6], suffix: '°', label: 'diminished' },
  aug: { intervals: [0, 4, 8], suffix: '+', label: 'augmented' },
  sus2: { intervals: [0, 2, 7], suffix: 'sus2', label: 'suspended 2nd' },
  sus4: { intervals: [0, 5, 7], suffix: 'sus4', label: 'suspended 4th' },
  '7': { intervals: [0, 4, 7, 10], suffix: '7', label: 'dominant 7th' },
  maj7: { intervals: [0, 4, 7, 11], suffix: 'maj7', label: 'major 7th' },
  m7: { intervals: [0, 3, 7, 10], suffix: 'm7', label: 'minor 7th' },
  m7b5: { intervals: [0, 3, 6, 10], suffix: 'm7b5', label: 'half-diminished 7th' },
  dim7: { intervals: [0, 3, 6, 9], suffix: '°7', label: 'diminished 7th' },
  '6': { intervals: [0, 4, 7, 9], suffix: '6', label: 'major 6th' },
  m6: { intervals: [0, 3, 7, 9], suffix: 'm6', label: 'minor 6th' },
  add9: { intervals: [0, 4, 7, 14], suffix: 'add9', label: 'added 9th' },
  '9': { intervals: [0, 4, 7, 10, 14], suffix: '9', label: 'dominant 9th' },
  m9: { intervals: [0, 3, 7, 10, 14], suffix: 'm9', label: 'minor 9th' },
  maj9: { intervals: [0, 4, 7, 11, 14], suffix: 'maj9', label: 'major 9th' },
  '5': { intervals: [0, 7], suffix: '5', label: 'power chord' }
};

export const CHORD_QUALITIES = Object.keys(CHORD_TYPES) as ChordQuality[];

export interface Chord {
  root: number;            // pitch class
  quality: ChordQuality;
  bass: number;            // pitch class of the lowest note
  name: string;            // 'Am/C' when the bass isn't the root
  pitches: number[];       // the notes it was recognized from, low to high
  confidence: number;      // 1: every note of the chord is there and nothing else
}

// The triad a chord is built on: what it does in a progression (G7 and G
// both act as V). Suspended chords and power chords have no 3rd; they take
// the key's own triad on their root.
export type ChordFamily = 'maj' | 'min' | 'dim' | 'aug';

const FAMILIES: Record<ChordQuality, ChordFamily | null> = {
  maj: 'maj', min: 'min', dim: 'dim', aug: 'aug', sus2: null, sus4: null, '7': 'maj', maj7: 'maj',
  m7: 'min', m7b5: 'dim', dim7: 'dim', '6': 'maj', m6: 'min', add9: 'maj', '9': 'maj', m9: 'min',
  maj9: 'maj', '5': null
};

export const SEVENTHS: ChordQuality[] = ['7', 'maj7', 'm7', 'm7b5', 'dim7', '9', 'm9', 'maj9'];

export const chordTones = (root: number, quality: ChordQuality) =>
  pitchClasses(CHORD_TYPES[quality].intervals.map(i => root + i));

// The notes a key's chords use: its scale, plus the raised 7th in minor
// (for V and vii°, as in harmonic minor)
export function keyPitchClasses(key: Key) {
  const notes = scalePitchClasses(key);
  return key.mode === 'minor' ? [...notes, pc(key.tonic + 11)] : notes;
}

export const fitsKey = (root: number, quality: ChordQuality, key: Key) =>
  chordTones(root, quality).every(p => keyPitchClasses(key).includes(p));

// The triads (and 7th chords) built on each degree of the scale, stacking
// the key's own 3rds
export function diatonicChords(key: Key, sevenths = false): { root: number; quality: ChordQuality; degree: number }[] {
  const scale = scalePitchClasses(key);
  return scale.map((root, degree) => {
    const tones = [0, 2, 4, 6].slice(0, sevenths ? 4 : 3).map(step => pc(scale[(degree + step) % 7] - root));
    const quality = CHORD_QUALITIES.find(q =>
      CHORD_TYPES[q].intervals.length === tones.length && CHORD_TYPES[q].intervals.every((i, n) => i === tones[n]))!;
    return { root, quality, degree };
  });
}

export function chordFamily(root: number, quality: ChordQuality, key?: Key): ChordFamily {
  const family = FAMILIES[quality];
  if (family) return family;
  const degree = key ? degreeOf(key, root) : null;
  if (key && degree !== null) return FAMILIES[diatonicChords(key)[degree].quality] ?? 'maj';
  return 'maj';
}

// Root-position pitches, the root as near `around` as it gets
export function chordPitches(root: number, quality: ChordQuality, around = 60): number[] {
  const bottom = nearestPitch(root, around);
  return CHORD_TYPES[quality].intervals.map(i => bottom + i);
}

// ---------------------------------------------------------------- names

// Without a key, notes are spelled as in C major: Bb, Eb, Ab and Db, but F#
const C_MAJOR: Key = { tonic: 0, mode: 'major' };

export function chordName(root: number, quality: ChordQuality, bass?: number, flats?: boolean) {
  const name = (p: number) => (flats === undefined ? spellInKey(p, C_MAJOR) : spell(p, flats));
  const slash = bass !== undefined && pc(bass) !== pc(root) ? `/${name(bass)}` : '';
  return name(root) + CHORD_TYPES[quality].suffix + slash;
}

export function chordNameInKey(root: number, quality: ChordQuality, key: Key, bass?: number) {
  const slash = bass !== undefined && pc(bass) !== pc(root) ? `/${spellInKey(bass, key)}` : '';
  return spellInKey(root, key) + CHORD_TYPES[quality].suffix + slash;
}

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// What follows the numeral; its case already says major or minor
const NUMERAL_SUFFIXES: Record<ChordQuality, string> = {
  maj: '', min: '', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', '7': '7', maj7: 'maj7', m7: '7',
  m7b5: 'ø7', dim7: '°7', '6': '6', m6: '6', add9: 'add9', '9': '9', m9: '9', maj9: 'maj9', '5': '5'
};

// 'I', 'vi', 'V7', 'ii°', 'bVII': uppercase for major chords, lowercase for
// minor and diminished ones, an accidental for a root outside the key. In
// minor the leading tone (G# in A minor) belongs to the key's V and vii°,
// so it takes no sharp.
export function romanNumeral(root: number, quality: ChordQuality, key: Key) {
  const interval = pc(root - key.tonic);
  let degree = degreeOf(key, root);
  let accidental = '';
  if (degree === null) {
    degree = nearestDegree(key, root);
    const leadingTone = key.mode === 'minor' && interval === 11;
    if (!leadingTone) accidental = interval > scaleIntervals(key)[degree] ? '#' : 'b';
  }
  const family = FAMILIES[quality];   // no 3rd (sus, power chord): uppercase
  const numeral = family === 'min' || family === 'dim' ? NUMERALS[degree].toLowerCase() : NUMERALS[degree];
  return accidental + numeral + NUMERAL_SUFFIXES[quality];
}

// The other way round: 'ii7' in C major is D m7. Lowercase 'vii' in minor
// is on the leading tone (G#° in A minor), uppercase 'VII' on the 7th (G).
export function parseNumeral(numeral: string, key: Key): { root: number; quality: ChordQuality } {
  const match = /^([b#]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(numeral);
  if (!match) throw new Error(`Not a Roman numeral: ${numeral}`);
  const [, accidental, letters, suffix] = match;
  const lower = letters === letters.toLowerCase();
  const degree = NUMERALS.indexOf(letters.toUpperCase());
  const quality = CHORD_QUALITIES.find(q =>
    NUMERAL_SUFFIXES[q] === suffix && ['maj', 'aug', 'sus2', 'sus4', '5', '7', 'maj7', '6', 'add9', '9', 'maj9']
      .includes(q) !== lower);
  if (!quality) throw new Error(`Unknown chord in ${numeral}`);
  const leadingTone = key.mode === 'minor' && degree === 6 && lower && !accidental;
  const interval = leadingTone ? 11 : scaleIntervals(key)[degree] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  return { root: pc(key.tonic + interval), quality };
}

// ---------------------------------------------------------- recognition

// When two chords explain the same notes equally well and neither has its
// root in the bass, the more common reading wins (Am7 over C6)
const PREFERENCE: ChordQuality[] = [
  'maj', 'min', '7', 'm7', 'maj7', '5', 'dim', 'sus4', 'sus2', 'aug', 'm7b5', '6', 'm6', 'dim7', 'add9', '9', 'm9', 'maj9'
];
const TRIADS: ChordQuality[] = ['maj', 'min', 'dim', 'aug'];

// Every root and type is scored on how well it explains the held notes:
// first that it explains all of them, then that few of its own notes are
// missing, then that it's small (a triad before a 7th); ties go to the
// chord with its root in the bass, then to one that fits the key. Two
// notes a 5th apart are a power chord; any other two are the most likely
// triad holding both (low confidence), or nothing.
export function recognizeChord(pitches: number[], key?: Key): Chord | null {
  const notes = [...new Set(pitches)].sort((a, b) => a - b);
  const held = new Set(notes.map(pc));
  if (held.size < 2) return null;
  const bass = pc(notes[0]);
  const dyad = held.size === 2;

  // A big cluster may hold one note no chord explains (a passing tone)
  for (const extraAllowed of held.size >= 4 ? [0, 1] : [0]) {
    let best: { root: number; quality: ChordQuality; cost: number; confidence: number } | null = null;
    for (const quality of PREFERENCE) {
      if (dyad && quality !== '5' && !TRIADS.includes(quality)) continue;
      for (let root = 0; root < 12; root++) {
        const tones = chordTones(root, quality);
        const extra = [...held].filter(p => !tones.includes(p)).length;
        const missing = tones.filter(p => !held.has(p)).length;
        const hasRoot = held.has(root);
        if (extra !== extraAllowed || missing > 2 || (missing > 0 && !hasRoot && !dyad)) continue;
        const cost = missing * 10 + tones.length + (hasRoot ? 0 : 5) + (root === bass ? 0 : 0.5) +
          (key && !fitsKey(root, quality, key) ? 0.25 : 0);
        if (best && cost >= best.cost) continue;
        const confidence = ((tones.length - missing) / tones.length) * (dyad && quality !== '5' ? 0.6 : 1) * (extra ? 0.6 : 1);
        best = { root, quality, cost, confidence };
      }
    }
    if (best) {
      const { root, quality, confidence } = best;
      const name = key ? chordNameInKey(root, quality, key, bass) : chordName(root, quality, bass);
      return { root, quality, bass, name, pitches: notes, confidence: Math.round(confidence * 100) / 100 };
    }
  }
  return null;
}
