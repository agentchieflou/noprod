// Control values: what an event carries (note, s, gain…), note names, scales
// and the arithmetic on them.

import { PatternError } from './errors.ts';
import type { MiniValue } from './mini.ts';

export type Controls = Record<string, MiniValue | undefined>;

export const isControls = (v: unknown): v is Controls => typeof v === 'object' && v !== null && !Array.isArray(v);

// Note names as the language reads them: "c3" is MIDI 48, "eb4" 63, "C#" 49;
// # or s sharpens, b flattens; the octave defaults to 3. Numbers are MIDI.
export function noteToMidi(note: MiniValue | undefined, what = 'a note'): number {
  if (typeof note === 'number') {
    if (!Number.isFinite(note)) throw new PatternError(`${what} wants a number or a note name, not ${note}`);
    return note;
  }
  if (typeof note !== 'string') throw new PatternError(`${what} wants a number or a note name, not ${JSON.stringify(note)}`);
  const text = note.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(text);
  if (!m) throw new PatternError(`${what} wants a number or a note name, not "${note}"`);
  const chroma = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const accidentals = [...m[2]].reduce((n, c) => n + (c === 'b' ? -1 : 1), 0);
  return (Number(m[3] ?? 3) + 1) * 12 + chroma + accidentals;
}

// Scales by name, as semitones from the root. "C:major", "A2:minor",
// "C:minor:pentatonic" (or "C:minor_pentatonic"; a space would make it two
// mini-notation steps).
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11], 'melodic minor': [0, 2, 3, 5, 7, 9, 11],
  'major pentatonic': [0, 2, 4, 7, 9], 'minor pentatonic': [0, 3, 5, 7, 10], pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10], 'minor blues': [0, 3, 5, 6, 7, 10], 'major blues': [0, 2, 3, 4, 7, 9],
  'whole tone': [0, 2, 4, 6, 8, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ritusen: [0, 2, 5, 7, 9], egyptian: [0, 2, 5, 7, 10], 'harmonic major': [0, 2, 4, 5, 7, 8, 11],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11], augmented: [0, 3, 4, 7, 8, 11], 'hungarian minor': [0, 2, 3, 6, 7, 8, 11]
};
export const SCALE_NAMES = Object.keys(SCALES);

export interface Scale { root: number; steps: number[]; name: string }

export function parseScale(spec: MiniValue | undefined): Scale {
  if (typeof spec !== 'string') throw new PatternError(`scale wants a name like "C:major", not ${JSON.stringify(spec)}`);
  const parts = spec.trim().split(/[:\s_]+/).filter(Boolean);
  if (parts.length < 2) throw new PatternError(`scale wants a root and a name, like "C:major", not "${spec}"`);
  const root = noteToMidi(parts[0], 'a scale root');
  const name = parts.slice(1).join(' ').toLowerCase();
  const steps = SCALES[name];
  if (!steps) throw new PatternError(`unknown scale "${parts.slice(1).join(':')}"; try one of ${SCALE_NAMES.join(', ')}`);
  return { root, steps, name };
}

// Degree d of a scale as a MIDI note (degrees wrap into the next octaves)
export function scaleDegree(scale: Scale, degree: MiniValue | undefined): number {
  if (typeof degree !== 'number' || !Number.isFinite(degree)) throw new PatternError(`scale wants whole-number degrees from n(), not ${JSON.stringify(degree)}`);
  const d = Math.round(degree);
  const n = scale.steps.length;
  const octave = Math.floor(d / n);
  return scale.root + octave * 12 + scale.steps[((d % n) + n) % n];
}

// Which control a number applies to when none is named: the note, else n
export function pitchKey(c: Controls): 'note' | 'n' | undefined {
  if (c.note !== undefined) return 'note';
  if (c.n !== undefined) return 'n';
  return undefined;
}

const asNumber = (v: MiniValue | undefined, what: string): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new PatternError(`${what} wants a number, not ${JSON.stringify(v)}`);
};

// value + amount: notes by name become MIDI numbers
export function addToValue(value: MiniValue | undefined, amount: MiniValue | undefined, key: string): MiniValue {
  const n = asNumber(amount, `adding to ${key}`);
  if (key === 'note') return noteToMidi(value, 'note') + n;
  return asNumber(value, key) + n;
}

// Adds `amount` to a control value: a number goes to the note (or n); a
// control object adds key by key
export function addControls(c: Controls, amount: MiniValue | Controls | undefined): Controls {
  if (isControls(amount)) {
    const out = { ...c };
    for (const [key, v] of Object.entries(amount)) {
      if (v === undefined) continue;
      out[key] = c[key] === undefined ? v : addToValue(c[key], v, key);
    }
    return out;
  }
  const key = pitchKey(c);
  if (!key) throw new PatternError('add wants a pattern with a note or n to add to');
  return { ...c, [key]: addToValue(c[key], amount, key) };
}

// s("bd:3") is the sound bd, sample 3
export function soundControls(value: MiniValue | undefined): Controls {
  if (typeof value === 'number') return { s: String(value) };
  if (typeof value !== 'string') throw new PatternError(`s wants a sound name, not ${JSON.stringify(value)}`);
  const [s, n, ...rest] = value.split(':');
  if (rest.length) throw new PatternError(`a sound is "name" or "name:index", not "${value}"`);
  if (n === undefined) return { s };
  if (!/^-?\d+$/.test(n)) throw new PatternError(`a sample index is a whole number, not "${n}"`);
  return { s, n: Number(n) };
}
