// Voice leading: play the next chord with the hands moving as little as
// possible. Each of its notes may go in any inversion and octave; the
// voicing whose notes are fewest semitones away from the last one wins.

import { chordPitches, chordTones, type ChordQuality } from './chords.ts';
import { fitRange } from './notes.ts';

const MAX_SPAN = 24;   // two octaves: what two hands can hold

const sorted = (pitches: readonly number[]) => [...pitches].sort((a, b) => a - b);

// Total semitones moved from one voicing to another. Voices pair in order
// (bass to bass, top to top); when the counts differ, a voice may split in
// two or two may merge (dynamic time warping over the sorted notes).
export function movement(from: readonly number[], to: readonly number[]): number {
  const a = sorted(from), b = sorted(to);
  if (!a.length || !b.length) return 0;
  if (a.length === b.length) return a.reduce((sum, p, i) => sum + Math.abs(p - b[i]), 0);
  const cost = a.map(() => new Array<number>(b.length).fill(Infinity));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const previous = i === 0 && j === 0 ? 0 : Math.min(
        i > 0 && j > 0 ? cost[i - 1][j - 1] : Infinity,
        i > 0 ? cost[i - 1][j] : Infinity,
        j > 0 ? cost[i][j - 1] : Infinity
      );
      cost[i][j] = Math.abs(a[i] - b[j]) + previous;
    }
  }
  return cost[a.length - 1][b.length - 1];
}

// Root position near middle C, moved by octaves to fit the range
function rootPosition(root: number, quality: ChordQuality, [low, high]: readonly [number, number]) {
  let pitches = chordPitches(root, quality, 60);
  while (pitches[pitches.length - 1] > high && pitches[0] - 12 >= low) pitches = pitches.map(p => p - 12);
  while (pitches[0] < low && pitches[pitches.length - 1] + 12 <= high) pitches = pitches.map(p => p + 12);
  // A range narrower than the chord: fold each note in on its own
  return sorted([...new Set(pitches.map(p => fitRange(p, [low, high])).filter(p => p !== null))]);
}

const pitchesOf = (pitchClass: number, low: number, high: number) => {
  const out: number[] = [];
  for (let p = low + ((pitchClass - low) % 12 + 12) % 12; p <= high; p += 12) out.push(p);
  return out;
};

export function voiceLead(from: number[], root: number, quality: ChordQuality, range: [number, number] = [48, 84]): number[] {
  if (!from.length) return rootPosition(root, quality, range);
  const tones = chordTones(root, quality);
  const low = Math.min(...from), high = Math.max(...from);

  // Each chord tone may go in any octave within an octave of the old
  // voicing (or anywhere in range, when the old voicing is outside it)
  let options = tones.map(t => pitchesOf(t, Math.max(range[0], low - 12), Math.min(range[1], high + 12)));
  if (options.some(o => !o.length)) options = tones.map(t => pitchesOf(t, range[0], range[1]));
  if (options.some(o => !o.length)) return rootPosition(root, quality, range);

  const center = (ps: number[]) => ps.reduce((s, p) => s + p, 0) / ps.length;
  const best = { pitches: [] as number[], score: [Infinity] };
  const choose = (i: number, picked: number[]) => {
    if (i === options.length) {
      const pitches = sorted(picked);
      const span = pitches[pitches.length - 1] - pitches[0];
      // Hand-sized first, then least movement; then a compact voicing
      // that stays where the hands were; then the lower one
      const score = [span > MAX_SPAN ? 1 : 0, movement(from, pitches), span, Math.abs(center(pitches) - center(from)), pitches[0]];
      if (compare(score, best.score) < 0) Object.assign(best, { pitches, score });
      return;
    }
    for (const p of options[i]) choose(i + 1, [...picked, p]);
  };
  choose(0, []);
  return best.pitches;
}

function compare(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
