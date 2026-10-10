// Finding the key from the notes played: the Krumhansl-Schmuckler
// algorithm. Count how much each pitch class sounds, then correlate the
// counts with a profile of how well each note fits each of the 24 keys.

import { pc } from './notes.ts';
import { ALL_KEYS, sameKey, type Key } from './scales.ts';

// Krumhansl & Kessler's probe-tone ratings (1982): how well each note fits
// a major or a minor key, from the tonic up by semitones
export const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  key: Key;
  score: number;                          // Pearson correlation, -1..1
  ranked: { key: Key; score: number }[];  // all 24 keys, best first
}

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

function correlation(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// `histogram`: how much each pitch class (C = 0) sounded. Ties keep the
// order of ALL_KEYS, so an empty histogram reads as C major.
export function findKey(histogram: number[]): KeyEstimate {
  const counts = Array.from({ length: 12 }, (_, i) => histogram[i] ?? 0);
  const ranked = ALL_KEYS
    .map(key => {
      const profile = key.mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      return { key, score: correlation(counts, counts.map((_, i) => profile[pc(i - key.tonic)])) };
    })
    .sort((a, b) => b.score - a.score);
  return { key: ranked[0].key, score: ranked[0].score, ranked };
}

// The key of what's being played now: a histogram whose old notes fade
// (halving every `halfLifeSeconds`), so a change of key wins within a few
// bars. Repeated and longer notes count more (observe a note-off with its
// length as the weight). The key only changes when another one fits
// clearly better, so it doesn't flicker between close keys.
const SWITCH_MARGIN = 0.05;

export class KeyTracker {
  private readonly halfLife: number;
  private readonly weights = new Array<number>(12).fill(0);
  private last = -Infinity;
  private current: Key = { tonic: 0, mode: 'major' };

  constructor(halfLifeSeconds = 8) {
    this.halfLife = halfLifeSeconds;
  }

  observe(pitch: number, time: number, weight = 1) {
    if (time > this.last && Number.isFinite(this.last)) {
      const fade = Math.pow(0.5, (time - this.last) / this.halfLife);
      for (let i = 0; i < 12; i++) this.weights[i] *= fade;
    }
    this.last = Math.max(this.last, time);
    this.weights[pc(pitch)] += weight;

    const { ranked } = findKey(this.weights);
    const now = ranked.find(r => sameKey(r.key, this.current))!;
    if (ranked[0].score - now.score > SWITCH_MARGIN) this.current = ranked[0].key;
  }

  key(): Key {
    return { ...this.current };
  }

  histogram(): number[] {
    return [...this.weights];
  }

  reset() {
    this.weights.fill(0);
    this.last = -Infinity;
    this.current = { tonic: 0, mode: 'major' };
  }
}
