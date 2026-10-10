// Which note comes next in a melody. A small corpus of public-domain tunes
// says how scale degrees follow one another; an interval prior says melodies
// mostly step, sometimes leap, and step back after a big leap; tendency
// tones pull toward their resolutions; the chord underneath favors its notes.

import { chordPitches, chordTones, type ChordQuality } from './chords.ts';
import { pc } from './notes.ts';
import { degreeOf, nearestDegree, scalePitchClasses, type Key } from './scales.ts';

export interface Melody {
  id: string;
  name: string;
  key: Key;
  notes: string;   // note names, 'C4 D4 E4'
}

const C_MAJOR: Key = { tonic: 0, mode: 'major' };
const G_MAJOR: Key = { tonic: 7, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };

// Traditional tunes and Beethoven's theme, all long in the public domain
export const MELODIES: Melody[] = [
  {
    id: 'twinkle', name: 'Twinkle Twinkle Little Star', key: C_MAJOR,
    notes: `C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4
            G4 G4 F4 F4 E4 E4 D4 G4 G4 F4 F4 E4 E4 D4
            C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4`
  },
  {
    id: 'ode-to-joy', name: 'Ode to Joy', key: C_MAJOR,
    notes: `E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4
            E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4
            D4 D4 E4 C4 D4 E4 F4 E4 C4 D4 E4 F4 E4 D4 C4 D4 G3
            E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4`
  },
  {
    id: 'frere-jacques', name: 'Frère Jacques', key: C_MAJOR,
    notes: `C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4 E4 F4 G4
            G4 A4 G4 F4 E4 C4 G4 A4 G4 F4 E4 C4 C4 G3 C4 C4 G3 C4`
  },
  {
    id: 'mary', name: 'Mary Had a Little Lamb', key: C_MAJOR,
    notes: `E4 D4 C4 D4 E4 E4 E4 D4 D4 D4 E4 G4 G4
            E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4`
  },
  {
    id: 'amazing-grace', name: 'Amazing Grace', key: G_MAJOR,
    notes: `D4 G4 B4 G4 B4 A4 G4 E4 D4 D4 G4 B4 G4 B4 A4 D5
            B4 D5 B4 G4 B4 A4 G4 E4 D4 D4 G4 B4 G4 B4 A4 G4`
  },
  {
    id: 'greensleeves', name: 'Greensleeves', key: A_MINOR,
    notes: `A4 C5 D5 E5 F5 E5 D5 B4 G4 A4 B4 C5 A4 A4 G#4 A4 B4 G#4 E4
            A4 C5 D5 E5 F5 E5 D5 B4 G4 A4 B4 C5 B4 A4 G#4 F#4 G#4 A4`
  },
  {
    id: 'saints', name: 'When the Saints Go Marching In', key: C_MAJOR,
    notes: `C4 E4 F4 G4 C4 E4 F4 G4 C4 E4 F4 G4 E4 C4 E4 D4
            E4 E4 D4 C4 C4 E4 G4 G4 F4 E4 F4 G4 E4 C4 D4 C4`
  },
  {
    id: 'scarborough-fair', name: 'Scarborough Fair', key: A_MINOR,
    notes: `A4 A4 E5 E5 E5 B4 C5 B4 A4 E5 G5 A5 G5 E5 F#5 D5 E5
            A5 A5 A5 G5 E5 E5 D5 C5 B4 A4 E5 D5 C5 B4 A4 G4 A4`
  },
  {
    id: 'london-bridge', name: 'London Bridge', key: C_MAJOR,
    notes: `G4 A4 G4 F4 E4 F4 G4 D4 E4 F4 E4 F4 G4
            G4 A4 G4 F4 E4 F4 G4 D4 G4 E4 C4`
  },
  {
    id: 'row-your-boat', name: 'Row Row Row Your Boat', key: C_MAJOR,
    notes: `C4 C4 C4 D4 E4 E4 D4 E4 F4 G4
            C5 C5 C5 G4 G4 G4 E4 E4 E4 C4 C4 C4 G4 F4 E4 D4 C4`
  }
];

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// 'C4' → 60, 'Bb3' → 58, 'F#5' → 78
export function parseNote(name: string): number {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Not a note: ${name}`);
  const [, letter, accidental, octave] = match;
  return LETTERS[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + (Number(octave) + 1) * 12;
}

export const melodyPitches = (melody: Melody) => melody.notes.trim().split(/\s+/).map(parseNote);

// ------------------------------------------------------------ statistics

// Degree bigrams and trigrams over the corpus, one table per mode: tunes in
// the same mode count three times, the others once (a 7th leads home in
// both, but minor tunes alone are too few)
interface Stats {
  bigrams: number[][];     // [from][to]
  trigrams: number[][];    // [7 * before + from][to]
}

function buildStats(mode: Key['mode']): Stats {
  const grid = (rows: number) => Array.from({ length: rows }, () => new Array<number>(7).fill(0));
  const stats = { bigrams: grid(7), trigrams: grid(49) };
  for (const melody of MELODIES) {
    const weight = melody.key.mode === mode ? 3 : 1;
    const degrees = melodyPitches(melody).map(p => nearestDegree(melody.key, p));
    for (let i = 1; i < degrees.length; i++) {
      stats.bigrams[degrees[i - 1]][degrees[i]] += weight;
      if (i >= 2) stats.trigrams[7 * degrees[i - 2] + degrees[i - 1]][degrees[i]] += weight;
    }
  }
  return stats;
}

const STATS: Record<Key['mode'], Stats> = { major: buildStats('major'), minor: buildStats('minor') };

// Add-one smoothing: a move the corpus never made is unlikely, not impossible
const smoothed = (row: number[], to: number) => (row[to] + 1) / (row.reduce((s, x) => s + x, 0) + 7);

// ----------------------------------------------------------- suggestions

// How likely each interval is, by semitones (0 to an octave): repeats and
// steps most, 3rds often, 4ths and 5ths sometimes, the rest rarely
const INTERVAL_PRIOR = [0.7, 0.9, 1, 0.55, 0.5, 0.35, 0.12, 0.3, 0.15, 0.13, 0.06, 0.05, 0.12];
const LEAP = 5;            // a 4th or more is a leap to recover from
const RECOVERY = 2.5;      // ...by a step the other way
const ONWARD = 0.5;        // ...rather than further on
const CHORD_TONE = 1.8;

// Tendency tones, by degree (0 = tonic): [from, to, direction, pull]
const TENDENCIES: Record<Key['mode'], [number, number, number, number][]> = {
  major: [[6, 0, 1, 2.5], [3, 2, -1, 1.6], [1, 0, -1, 1.4], [1, 2, 1, 1.2]],
  minor: [[6, 0, 1, 1.6], [5, 4, -1, 1.6], [3, 2, -1, 1.5], [1, 0, -1, 1.4], [1, 2, 1, 1.2]]
};

export interface NoteSuggestion {
  pitch: number;
  weight: number;
  reason: string;
}

function tendency(key: Key, last: number, pitch: number) {
  const interval = pitch - last;
  if (Math.abs(interval) > 2 || interval === 0) return 1;
  // A note a semitone under the tonic (the leading tone, or a raised 7th
  // in minor) pulls hardest
  if (pc(last - key.tonic) === 11 && interval === 1) return 2.5;
  const from = nearestDegree(key, last), to = nearestDegree(key, pitch);
  const rule = TENDENCIES[key.mode].find(([f, t, direction]) => f === from && t === to && Math.sign(interval) === direction);
  return rule ? rule[3] : 1;
}

const normalized = <T extends { weight: number }>(items: T[]) => {
  const sum = items.reduce((s, x) => s + x.weight, 0) || 1;
  return items.map(x => ({ ...x, weight: x.weight / sum }));
};

// `recent`: MIDI pitches, most recent last
export function nextNotes(
  recent: number[], key: Key, chord: { root: number; quality: ChordQuality } | null = null, count = 4
): NoteSuggestion[] {
  if (!recent.length) {
    // Nothing played yet: start on the tonic triad, around middle C
    const [tonic, third, fifth] = chordPitches(key.tonic, key.mode === 'major' ? 'maj' : 'min', 60);
    return normalized([
      { pitch: tonic, weight: 0.4, reason: 'the tonic' },
      { pitch: fifth, weight: 0.25, reason: 'the 5th of the key' },
      { pitch: third, weight: 0.2, reason: 'the 3rd of the key' },
      { pitch: tonic + 12, weight: 0.15, reason: 'the tonic' }
    ].slice(0, count));
  }

  const last = recent[recent.length - 1];
  const leap = recent.length >= 2 ? last - recent[recent.length - 2] : 0;
  const degrees = recent.slice(-2).map(p => nearestDegree(key, p));
  const { bigrams, trigrams } = STATS[key.mode];
  const scale = scalePitchClasses(key);
  const chordNotes = chord ? chordTones(chord.root, chord.quality) : [];

  const candidates: NoteSuggestion[] = [];
  for (let pitch = Math.max(0, last - 12); pitch <= Math.min(127, last + 12); pitch++) {
    if (!scale.includes(pc(pitch))) continue;
    const degree = degreeOf(key, pitch)!;
    const interval = pitch - last;
    const size = Math.abs(interval);

    const from = degrees[degrees.length - 1];
    let corpus = smoothed(bigrams[from], degree);
    if (degrees.length === 2) corpus = 0.6 * smoothed(trigrams[7 * degrees[0] + from], degree) + 0.4 * corpus;

    let weight = corpus * INTERVAL_PRIOR[size];
    let reason = size === 0 ? 'repeat' : size <= 2 ? 'step' : 'leap';
    if (chordNotes.includes(pc(pitch))) {
      weight *= CHORD_TONE;
      if (size > 2) reason = 'chord tone';
    }
    if (Math.abs(leap) >= LEAP && size > 0) {
      if (Math.sign(interval) === Math.sign(leap)) weight *= ONWARD;
      else if (size <= 2) {
        weight *= RECOVERY;
        reason = 'steps back after the leap';
      }
    }
    const pull = tendency(key, last, pitch);
    if (pull > 1) {
      weight *= pull;
      reason = 'resolves';
    }
    candidates.push({ pitch, weight, reason });
  }

  // Ties go to the smaller move, then the lower note
  candidates.sort((a, b) => b.weight - a.weight || Math.abs(a.pitch - last) - Math.abs(b.pitch - last) || a.pitch - b.pitch);
  return normalized(candidates.slice(0, count));
}
