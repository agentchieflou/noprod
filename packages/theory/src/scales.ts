// Scales and keys. A key is a tonic and a mode; its notes are the major
// scale or the natural minor scale on the tonic.

import { pc, spell } from './notes.ts';

// Intervals from the root (the same scales as the DAW's computer keyboard)
export const SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10]
};

export interface Key {
  tonic: number;   // pitch class
  mode: 'major' | 'minor';
}

// All 24 keys, majors first
export const ALL_KEYS: Key[] = (['major', 'minor'] as const)
  .flatMap(mode => Array.from({ length: 12 }, (_, tonic) => ({ tonic, mode })));

export const sameKey = (a: Key, b: Key) => pc(a.tonic) === pc(b.tonic) && a.mode === b.mode;

// Keys written with flats: F, Bb, Eb, Ab, Db major and D, G, C, F, Bb, Eb
// minor; the rest with sharps (or neither)
const FLAT_MAJORS = [5, 10, 3, 8, 1];
const FLAT_MINORS = [2, 7, 0, 5, 10, 3];
export const usesFlats = (key: Key) => (key.mode === 'major' ? FLAT_MAJORS : FLAT_MINORS).includes(pc(key.tonic));

export const keyName = (key: Key) => `${spell(key.tonic, usesFlats(key))} ${key.mode}`;

export const scaleIntervals = (key: Key) => (key.mode === 'major' ? SCALES.Major : SCALES.Minor);

export const scalePitchClasses = (key: Key) => scaleIntervals(key).map(i => pc(key.tonic + i));

// 0 for the tonic up to 6 for the 7th; null for a note outside the key
export function degreeOf(key: Key, pitchClass: number): number | null {
  const degree = scalePitchClasses(key).indexOf(pc(pitchClass));
  return degree >= 0 ? degree : null;
}

// A note outside the key is heard as one of its degrees, altered: in a
// major key a sharp 4th or a flat 2nd, 3rd, 6th or 7th; in a minor key a
// flat 2nd or a raised 3rd, 4th, 6th or 7th (the 6th and 7th of melodic
// and harmonic minor)
const raised = (key: Key, interval: number) => (key.mode === 'major' ? interval === 6 : interval !== 1);

export function nearestDegree(key: Key, pitchClass: number): number {
  const degree = degreeOf(key, pitchClass);
  if (degree !== null) return degree;
  const interval = pc(pitchClass - key.tonic);
  return degreeOf(key, key.tonic + interval + (raised(key, interval) ? -1 : 1)) ?? 0;
}

// A note's name as the key writes it: its own accidentals for its notes,
// sharps for raised notes and flats for lowered ones (Bb in C, G# in A minor)
export function spellInKey(pitchClass: number, key: Key) {
  if (degreeOf(key, pitchClass) !== null) return spell(pitchClass, usesFlats(key));
  return spell(pitchClass, !raised(key, pc(pitchClass - key.tonic)));
}
