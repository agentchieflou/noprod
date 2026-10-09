// Musical grid over the arrangement timeline (which is measured in seconds).
// Tempo is project-wide; the time signature can change at bar boundaries via
// a list of { bar, numerator, denominator } entries (bar is 0-based).

export const PIXELS_PER_SECOND = 50;

export interface TimeSig {
  bar: number;
  numerator: number;
  denominator: number;
}

export const DEFAULT_TIME_SIG: TimeSig = { bar: 0, numerator: 4, denominator: 4 };

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

const sortedSigs = (sigs?: TimeSig[]) =>
  sigs && sigs.length ? [...sigs].sort((a, b) => a.bar - b.bar) : [DEFAULT_TIME_SIG];

// Seconds in one bar of the given signature (beats are 1/denominator notes)
export const barSeconds = (bpm: number, sig: { numerator: number; denominator: number }) =>
  sig.numerator * (4 / sig.denominator) * beatSeconds(bpm);

// Bars covering [0, until) seconds, honouring signature changes.
export function barsUntil(bpm: number, until: number, sigs?: TimeSig[]): Bar[] {
  const list = sortedSigs(sigs);
  const out: Bar[] = [];
  let si = 0;
  for (let i = 0, t = 0; t < until; i++) {
    while (si + 1 < list.length && list[si + 1].bar <= i) si++;
    const { numerator, denominator } = list[si];
    const length = barSeconds(bpm, list[si]);
    out.push({ index: i, time: t, length, numerator, denominator });
    t += length;
  }
  return out;
}

// The bar containing a timeline position
export function barAt(bpm: number, time: number, sigs?: TimeSig[]): Bar {
  const bars = barsUntil(bpm, time + 1e-6, sigs);
  return bars[bars.length - 1] || { index: 0, time: 0, length: barSeconds(bpm, DEFAULT_TIME_SIG), numerator: 4, denominator: 4 };
}

// Beats in [from, to); the first beat of each bar is accented (metronome).
export function beatsBetween(bpm: number, from: number, to: number, sigs?: TimeSig[]) {
  const out: { time: number; accent: boolean }[] = [];
  barsUntil(bpm, to, sigs).forEach((bar) => {
    if (bar.time + bar.length <= from) return;
    const beat = bar.length / bar.numerator;
    for (let k = 0; k < bar.numerator; k++) {
      const time = bar.time + k * beat;
      if (time >= from && time < to) out.push({ time, accent: k === 0 });
    }
  });
  return out;
}
