// Notes: MIDI pitches, pitch classes and their names. MIDI 60 is C4
// (middle C); a pitch class is a pitch with the octave taken off (C = 0).

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Pitch class, also for negative numbers (intervals going down)
export const pc = (pitch: number) => ((pitch % 12) + 12) % 12;

export const spell = (pitchClass: number, flats = false) => (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[pc(pitchClass)];

// 'C4', 'Eb3': the octave changes at C, as on a piano
export const noteName = (pitch: number, flats = false) => spell(pitch, flats) + (Math.floor(pitch / 12) - 1);

// The pitch of a pitch class nearest `around` (ties go down)
export function nearestPitch(pitchClass: number, around: number) {
  const up = pc(pitchClass - around);
  return around + (up < 6 ? up : up - 12);
}

// Moves a pitch by octaves into [low, high]; null when the range is too
// narrow to hold its pitch class
export function fitRange(pitch: number, [low, high]: readonly [number, number]): number | null {
  let p = pitch;
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p >= low ? p : null;
}

// Distinct pitch classes, in the order first met
export const pitchClasses = (pitches: readonly number[]) => [...new Set(pitches.map(pc))];
