// Grids, ticks and quantization in beats (quarter notes). Equality on a grid
// is by snapping, never bitwise: positions are doubles.

// Ticks per quarter note, for display and MIDI files (Pro Tools and Logic use 960)
export const TICKS_PER_BEAT = 960;

export const toTicks = (beat: number) => Math.round(beat * TICKS_PER_BEAT);
export const fromTicks = (ticks: number) => ticks / TICKS_PER_BEAT;

// A grid division as the UI names it: a note value, or its triplet
export type Division = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/64'
  | '1/2T' | '1/4T' | '1/8T' | '1/16T' | '1/32T';

export const DIVISIONS: Division[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/2T', '1/4T', '1/8T', '1/16T', '1/32T'];

// The length of one grid step in beats: a 1/16 note is a quarter of a beat;
// a triplet fits three in the space of two
export function divisionBeats(division: Division): number {
  const triplet = division.endsWith('T');
  const denominator = Number(division.slice(2, triplet ? -1 : undefined));
  const beats = 4 / denominator;
  return triplet ? (beats * 2) / 3 : beats;
}

// The nearest grid line, counting from `origin`
export const snap = (beat: number, step: number, origin = 0) =>
  step > 0 ? origin + Math.round((beat - origin) / step) * step : beat;

// The grid lines either side of a beat (both equal to it when it is on one)
export function gridAround(beat: number, step: number, origin = 0): { below: number; above: number } {
  if (!(step > 0)) return { below: beat, above: beat };
  const below = origin + Math.floor((beat - origin) / step + 1e-9) * step;
  return { below, above: beat - below < 1e-9 ? below : below + step };
}

// Move a beat toward its nearest grid line by `strength` (1 = onto it)
export const quantize = (beat: number, step: number, strength = 1, origin = 0) =>
  beat + (snap(beat, step, origin) - beat) * Math.min(1, Math.max(0, strength));

// Is the beat on the grid, to within a tick?
export const onGrid = (beat: number, step: number, origin = 0) =>
  Math.abs(snap(beat, step, origin) - beat) < 0.5 / TICKS_PER_BEAT;
