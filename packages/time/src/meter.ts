// The meter map: the time signature of every bar, and bars.beats.ticks.
//
// Beats are quarter notes throughout noprod, so a bar of n/d is n·4/d beats:
// a 6/8 bar is 3 beats long and has 6 grid lines. Signatures change on bar
// lines, so events are indexed by bar (0-based), and bar 0 always has one.
// Before bar 0 the first signature holds (a count-in starts before the song).

import { TICKS_PER_BEAT } from './grid.ts';

export interface MeterEvent {
  bar: number;          // 0-based
  numerator: number;
  denominator: number;
}

export interface Bar {
  index: number;        // 0-based
  start: number;        // beats
  length: number;       // beats
  numerator: number;
  denominator: number;
}

// A position as shown: 1-based bar and beat (a beat here is one 1/d note),
// and ticks within that beat at TICKS_PER_BEAT per quarter note
export interface Bbt {
  bar: number;
  beat: number;
  tick: number;
}

export interface GridLine {
  beat: number;
  accent: boolean;      // the first line of a bar
}

export const DEFAULT_METER: MeterEvent = { bar: 0, numerator: 4, denominator: 4 };

export const beatsPerBar = (m: { numerator: number; denominator: number }) => (m.numerator * 4) / m.denominator;

const valid = (e: MeterEvent) =>
  Number.isInteger(e.bar) && Number.isInteger(e.numerator) && e.numerator >= 1 && e.numerator <= 64
  && Number.isInteger(e.denominator) && e.denominator >= 1 && e.denominator <= 64;

function normalize(events: readonly MeterEvent[]): MeterEvent[] {
  const byBar = new Map<number, MeterEvent>();
  for (const e of events) {
    if (!valid(e)) continue;
    const bar = Math.max(0, e.bar);
    byBar.set(bar, { bar, numerator: e.numerator, denominator: e.denominator });
  }
  const out = [...byBar.values()].sort((a, b) => a.bar - b.bar);
  if (!out.length) return [{ ...DEFAULT_METER }];
  if (out[0].bar > 0) out.unshift({ ...out[0], bar: 0 });
  return out;
}

function lastAtOrBefore(values: readonly number[], x: number): number {
  let lo = 0, hi = values.length - 1;
  if (x < values[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export class MeterMap {
  readonly events: readonly MeterEvent[];
  private readonly bars: number[];     // each event's bar
  private readonly starts: number[];   // the beat at which each event's bar starts

  constructor(events: readonly MeterEvent[] = [DEFAULT_METER]) {
    this.events = normalize(events);
    this.bars = this.events.map((e) => e.bar);
    this.starts = [0];
    for (let i = 1; i < this.events.length; i++) {
      const prev = this.events[i - 1];
      this.starts.push(this.starts[i - 1] + (this.events[i].bar - prev.bar) * beatsPerBar(prev));
    }
  }

  static from(json: unknown): MeterMap {
    return new MeterMap(Array.isArray(json) ? (json as MeterEvent[]) : undefined);
  }

  toJSON(): MeterEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  // The signature in effect at a bar
  meterAt(bar: number): MeterEvent {
    return this.events[lastAtOrBefore(this.bars, bar)];
  }

  // The beat a bar starts on (bars before 0 extrapolate with the first signature)
  beatOfBar(bar: number): number {
    const i = lastAtOrBefore(this.bars, bar);
    return this.starts[i] + (bar - this.events[i].bar) * beatsPerBar(this.events[i]);
  }

  // The bar containing a beat
  barAt(beat: number): Bar {
    const i = lastAtOrBefore(this.starts, beat);
    const e = this.events[i];
    const length = beatsPerBar(e);
    const index = e.bar + Math.floor((beat - this.starts[i]) / length);
    return { index, start: this.starts[i] + (index - e.bar) * length, length, numerator: e.numerator, denominator: e.denominator };
  }

  bbt(beat: number): Bbt {
    const bar = this.barAt(beat);
    const unit = 4 / bar.denominator;                  // one 1/d note, in beats
    const into = beat - bar.start;
    const b = Math.floor(into / unit + 1e-9);
    const tick = Math.floor((into - b * unit) * TICKS_PER_BEAT + 1e-6);
    return { bar: bar.index + 1, beat: b + 1, tick: Math.max(0, tick) };
  }

  fromBbt({ bar, beat, tick }: Bbt): number {
    const m = this.meterAt(bar - 1);
    return this.beatOfBar(bar - 1) + ((beat - 1) * 4) / m.denominator + tick / TICKS_PER_BEAT;
  }

  // The bars overlapping [from, to)
  barsBetween(from: number, to: number): Bar[] {
    const out: Bar[] = [];
    for (let bar = this.barAt(from); bar.start < to; bar = this.barAt(bar.start + bar.length)) out.push(bar);
    return out;
  }

  // The 1/d-note lines in [from, to), the first of each bar accented
  grid(from: number, to: number): GridLine[] {
    const out: GridLine[] = [];
    for (const bar of this.barsBetween(from, to)) {
      const unit = 4 / bar.denominator;
      for (let k = 0; k < bar.numerator; k++) {
        const beat = bar.start + k * unit;
        if (beat >= from && beat < to) out.push({ beat, accent: k === 0 });
      }
    }
    return out;
  }

  // The nearest multiple of `step` beats counted from the start of the bar
  // the beat is in, so a 1/4 grid in 7/8 restarts on every bar line
  snap(beat: number, step: number): number {
    if (!(step > 0)) return beat;
    const bar = this.barAt(beat);
    const snapped = bar.start + Math.round((beat - bar.start) / step) * step;
    // the next bar line is a grid line too, whatever the step
    const next = bar.start + bar.length;
    return Math.abs(next - beat) < Math.abs(snapped - beat) ? next : snapped;
  }

  withMeter(bar: number, numerator: number, denominator: number): MeterMap {
    return new MeterMap([...this.events.filter((e) => e.bar !== Math.max(0, bar)), { bar, numerator, denominator }]);
  }

  // Bar 0 keeps its signature: a map always has one
  withoutMeter(bar: number): MeterMap {
    return bar <= 0 ? this : new MeterMap(this.events.filter((e) => e.bar !== bar));
  }
}
