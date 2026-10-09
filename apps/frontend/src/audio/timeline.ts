// Musical grid over the arrangement timeline (which is measured in seconds).
// Tempo is project-wide; bars are 4 beats of 60/bpm seconds.

export const PIXELS_PER_SECOND = 50;

export const beatSeconds = (bpm: number) => 60 / bpm;

export const snapToBeat = (t: number, bpm: number) => {
  const b = beatSeconds(bpm);
  return Math.max(0, Math.round(t / b) * b);
};

export interface Bar {
  index: number;       // 0-based bar number
  time: number;        // start, seconds
  length: number;      // seconds
  numerator: number;
  denominator: number;
}

// Bars covering [0, until) seconds.
export function barsUntil(bpm: number, until: number): Bar[] {
  const len = beatSeconds(bpm) * 4;
  const out: Bar[] = [];
  for (let i = 0, t = 0; t < until; i++, t += len) {
    out.push({ index: i, time: t, length: len, numerator: 4, denominator: 4 });
  }
  return out;
}

// Beats in [from, to) with the first beat of each bar accented (metronome).
export function beatsBetween(bpm: number, from: number, to: number) {
  const spb = beatSeconds(bpm);
  const out: { time: number; accent: boolean }[] = [];
  for (let b = Math.max(0, Math.ceil(from / spb - 1e-9)); b * spb < to; b++) {
    out.push({ time: b * spb, accent: b % 4 === 0 });
  }
  return out;
}
