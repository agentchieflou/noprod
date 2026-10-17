// The chord lane over the piano roll: the chords a clip's notes spell, with
// where each one sounds. Pure logic, notes in and segments out.

import { findKey, recognizeChord, romanNumeral, chordNameInKey, spellInKey, type Chord, type Key } from '@noprod/theory';

export interface LaneNote { pitch: number; start: number; duration: number }
export interface LaneSegment { start: number; end: number; chord: Chord }

const EPS = 1e-6;

// The key of the clip: pitch classes weighted by how long they sound
export function clipKey(notes: LaneNote[]): Key {
  const histogram = new Array<number>(12).fill(0);
  for (const n of notes) histogram[((n.pitch % 12) + 12) % 12] += n.duration;
  return findKey(histogram).key;
}

// Split at every note start and end, name each stretch that holds 3 or more
// pitch classes, merge neighbors naming the same chord and drop what is
// shorter than `minDuration`. Fewer than 3 pitch classes stay unnamed.
export function chordSegments(notes: LaneNote[], key: Key, minDuration: number): LaneSegment[] {
  const edges = [...new Set(notes.flatMap(n => [n.start, n.start + n.duration]).map(t => Math.round(t / EPS)))]
    .sort((a, b) => a - b).map(t => t * EPS);
  const raw: LaneSegment[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [start, end] = [edges[i], edges[i + 1]];
    const mid = (start + end) / 2;
    const pitches = notes.filter(n => n.start < mid && mid < n.start + n.duration).map(n => n.pitch);
    if (new Set(pitches.map(p => ((p % 12) + 12) % 12)).size < 3) continue;
    const chord = recognizeChord(pitches, key);
    if (chord) raw.push({ start, end, chord });
  }
  const out: LaneSegment[] = [];
  for (const seg of raw.filter(s => s.end - s.start >= minDuration - EPS)) {
    const last = out[out.length - 1];
    if (last && last.chord.name === seg.chord.name && seg.start - last.end < minDuration - EPS) last.end = seg.end;
    else out.push({ ...seg });
  }
  return out;
}

export const keyName = (key: Key) => `${spellInKey(key.tonic, key)} ${key.mode}`;

// 'Am vi': the chord without its inversion, and its numeral in the key
export const chordLabel = ({ chord }: LaneSegment, key: Key) =>
  `${chordNameInKey(chord.root, chord.quality, key)} ${romanNumeral(chord.root, chord.quality, key)}`;

// 'G/B (V)': the full name, inversion included
export const chordTitle = ({ chord }: LaneSegment, key: Key) =>
  `${chord.name} (${romanNumeral(chord.root, chord.quality, key)})`;
