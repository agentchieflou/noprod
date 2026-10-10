// What to add to the notes being held. Part of a chord: the notes that
// complete the key's likely chords. A whole triad: its 7th, 9th or 6th.
// One note: harmonies a 3rd or a 6th away, in the key. Suggestions sit
// within an octave of the held notes.

import {
  chordFamily, chordNameInKey, chordTones, diatonicChords, keyPitchClasses, recognizeChord,
  type Chord, type ChordQuality
} from './chords.ts';
import { pc, pitchClasses } from './notes.ts';
import { nearestDegree, scalePitchClasses, type Key } from './scales.ts';

export interface ComplementSuggestion {
  pitch: number;
  weight: number;
  reason: string;
}

// How common each chord of the key is, by degree (0 = I); 7th chords count
// less than triads
const DEGREE_WEIGHTS: Record<Key['mode'], number[]> = {
  major: [0.25, 0.1, 0.06, 0.2, 0.2, 0.15, 0.04],
  minor: [0.25, 0.06, 0.12, 0.17, 0.08, 0.16, 0.12]
};
const SEVENTH_WEIGHT = 0.4;

export function complements(held: number[], key: Key): ComplementSuggestion[] {
  const notes = [...new Set(held)].sort((a, b) => a - b);
  if (!notes.length) return [];
  if (pitchClasses(notes).length === 1) return harmonies(notes, key);
  const chord = recognizeChord(notes, key);
  if (chord && chord.confidence === 1 && pitchClasses(notes).length >= 3) return additions(notes, chord, key);
  return completions(notes, key);
}

// The pitch of a pitch class just above the bass (the voicing keeps its bass)
const above = (pitchClass: number, bass: number) => bass + (pc(pitchClass - bass) || 12);

function ranked(scores: Map<number, { weight: number; reason: string; best: number }>) {
  const items = [...scores.entries()].map(([pitch, s]) => ({ pitch, weight: s.weight, reason: s.reason }));
  const sum = items.reduce((s, x) => s + x.weight, 0) || 1;
  return items
    .map(x => ({ ...x, weight: x.weight / sum }))
    .sort((a, b) => b.weight - a.weight || a.pitch - b.pitch);
}

// Two notes (or an incomplete chord): every chord of the key holding them
// votes for its missing notes, weighted by how common it is
function completions(notes: number[], key: Key) {
  const held = new Set(notes.map(pc));
  const chords: { root: number; quality: ChordQuality; weight: number }[] = [
    ...diatonicChords(key).map(c => ({ ...c, weight: DEGREE_WEIGHTS[key.mode][c.degree] })),
    ...diatonicChords(key, true).map(c => ({ ...c, weight: DEGREE_WEIGHTS[key.mode][c.degree] * SEVENTH_WEIGHT }))
  ];
  // Minor keys borrow V and V7 from harmonic minor
  if (key.mode === 'minor') {
    chords.push({ root: pc(key.tonic + 7), quality: 'maj', weight: 0.12 }, { root: pc(key.tonic + 7), quality: '7', weight: 0.05 });
  }

  const scores = new Map<number, { weight: number; reason: string; best: number }>();
  const vote = (root: number, quality: ChordQuality, weight: number) => {
    const missing = chordTones(root, quality).filter(p => !held.has(p));
    for (const p of missing) {
      const pitch = above(p, notes[0]);
      const share = weight / missing.length;
      const s = scores.get(pitch) ?? { weight: 0, reason: '', best: 0 };
      s.weight += share;
      if (share > s.best) Object.assign(s, { best: share, reason: `completes ${chordNameInKey(root, quality, key)}` });
      scores.set(pitch, s);
    }
  };
  for (const c of chords) {
    const tones = chordTones(c.root, c.quality);
    if ([...held].every(p => tones.includes(p)) && tones.length > held.size) vote(c.root, c.quality, c.weight);
  }
  // Nothing in the key holds these notes: complete what they sound like
  if (!scores.size) {
    const chord = recognizeChord(notes, key);
    if (chord) vote(chord.root, chord.quality, 1);
  }
  return ranked(scores);
}

// A whole chord: color it. A triad gets its 7th (whichever the key has),
// 9th and 6th, a 7th or 6th chord its 9th; notes outside the key count far
// less. (A power chord is two notes: it gets completed instead.)
function additions(notes: number[], chord: Chord, key: Key) {
  const inKey = keyPitchClasses(key);
  const family = chordFamily(chord.root, chord.quality, key);
  const options: { intervals: number[]; weight: number; what: string; octaveUp?: boolean }[] = [];
  const tones = chordTones(chord.root, chord.quality).length;
  if (chord.quality === 'sus2' || chord.quality === 'sus4') {
    options.push({ intervals: [10, 11], weight: 1, what: 'the 7th' });
  } else if (tones === 3) {
    const sevenths = family === 'maj' ? [11, 10] : family === 'dim' ? [10, 9] : family === 'min' ? [10, 11] : [10];
    options.push({ intervals: sevenths, weight: 0.5, what: 'the 7th' });
    if (family === 'maj' || family === 'min') {
      options.push({ intervals: [2], weight: 0.3, what: 'the 9th', octaveUp: true });
      options.push({ intervals: [9], weight: 0.2, what: 'the 6th' });
    }
  } else if (['7', 'maj7', 'm7', '6', 'm6'].includes(chord.quality)) {
    options.push({ intervals: [2], weight: 1, what: 'the 9th', octaveUp: true });
  }

  const scores = new Map<number, { weight: number; reason: string; best: number }>();
  const rootPitch = notes.find(p => pc(p) === chord.root) ?? notes[0];
  for (const option of options) {
    // The first of the intervals the key has; else the first, quietly
    const interval = option.intervals.find(i => inKey.includes(pc(chord.root + i)));
    const p = pc(chord.root + (interval ?? option.intervals[0]));
    const pitch = option.octaveUp ? above(p, rootPitch + 12) : above(p, notes[0]);
    const weight = option.weight * (interval === undefined ? 0.15 : 1);
    const name = recognizeChord([...notes, pitch], key)?.name;
    scores.set(pitch, { weight, reason: `adds ${option.what}${name ? ` (${name})` : ''}`, best: weight });
  }
  return ranked(scores);
}

// One note: the key's notes a 3rd and a 6th above it, and below
function harmonies(notes: number[], key: Key) {
  const scale = scalePitchClasses(key);
  const top = notes[notes.length - 1], bottom = notes[0];
  const degree = nearestDegree(key, top);
  const up = (steps: number) => above(scale[(degree + steps) % 7], top);
  const down = (steps: number) => {
    const p = scale[(degree - steps + 7) % 7];
    return bottom - (pc(bottom - p) || 12);
  };
  const scores = new Map<number, { weight: number; reason: string; best: number }>([
    [up(2), { weight: 0.35, reason: 'a 3rd above', best: 0 }],
    [up(5), { weight: 0.25, reason: 'a 6th above', best: 0 }],
    [down(2), { weight: 0.22, reason: 'a 3rd below', best: 0 }],
    [down(5), { weight: 0.18, reason: 'a 6th below', best: 0 }]
  ]);
  return ranked(scores);
}
