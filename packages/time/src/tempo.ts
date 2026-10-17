// The tempo map: where the tempo is at every beat, and the integral that
// turns beats into seconds and back.
//
// Events are sorted by beat, and there is always one at beat 0. An event
// holds its tempo until the next one, unless it ramps: then the tempo moves
// linearly in BPM over the beats to the next event (as Ableton's and Pro
// Tools' tempo ramps do). Both directions have closed forms:
//
//   constant:  t = 60 (b − b₀) / bpm₀
//   ramp:      t = (60 / k) ln(bpm(b) / bpm₀), k = (bpm₁ − bpm₀) / (b₁ − b₀)
//              b = b₀ + (bpm₀ / k) (e^(k t / 60) − 1)
//
// Before beat 0 the first tempo holds (a count-in has negative beats), and
// after the last event its tempo holds forever.

export const MIN_BPM = 20;
export const MAX_BPM = 999;

export interface TempoEvent {
  beat: number;
  bpm: number;
  ramp?: 'linear';   // the tempo ramps to the next event's
}

const clampBpm = (bpm: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, Number.isFinite(bpm) ? bpm : 120));

// Sorted, one event per beat (the last given wins), none before beat 0, and
// one at beat 0 (the first event's tempo reaches back to it)
function normalize(events: readonly TempoEvent[]): TempoEvent[] {
  const byBeat = new Map<number, TempoEvent>();
  for (const e of events) {
    if (!e || typeof e !== 'object' || !Number.isFinite(e.beat)) continue;
    const beat = Math.max(0, e.beat);
    byBeat.set(beat, { beat, bpm: clampBpm(e.bpm), ...(e.ramp === 'linear' ? { ramp: 'linear' as const } : {}) });
  }
  const out = [...byBeat.values()].sort((a, b) => a.beat - b.beat);
  if (!out.length) return [{ beat: 0, bpm: 120 }];
  if (out[0].beat > 0) out.unshift({ beat: 0, bpm: out[0].bpm });
  return out;
}

// Slope of a ramp in BPM per beat, 0 when the event holds its tempo
const slope = (e0: TempoEvent, e1: TempoEvent | undefined) =>
  e0.ramp === 'linear' && e1 && e1.beat > e0.beat ? (e1.bpm - e0.bpm) / (e1.beat - e0.beat) : 0;

// Seconds from e0 to `beat` within e0's segment
function segmentSeconds(e0: TempoEvent, e1: TempoEvent | undefined, beat: number): number {
  const b = beat - e0.beat;
  const k = slope(e0, e1);
  if (k === 0) return (60 * b) / e0.bpm;
  return (60 / k) * Math.log1p((k * b) / e0.bpm);
}

// Beats from e0 after `seconds` within e0's segment
function segmentBeats(e0: TempoEvent, e1: TempoEvent | undefined, seconds: number): number {
  const k = slope(e0, e1);
  if (k === 0) return (seconds * e0.bpm) / 60;
  return (e0.bpm / k) * Math.expm1((k * seconds) / 60);
}

// Index of the last element <= x in a sorted array, or 0
function lastAtOrBefore(values: readonly number[], x: number): number {
  let lo = 0, hi = values.length - 1;
  if (x < values[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export class TempoMap {
  readonly events: readonly TempoEvent[];
  private readonly beats: number[];    // each event's beat
  private readonly starts: number[];   // the seconds at which each event starts

  constructor(events: readonly TempoEvent[] = [{ beat: 0, bpm: 120 }]) {
    this.events = normalize(events);
    this.beats = this.events.map((e) => e.beat);
    this.starts = [0];
    for (let i = 1; i < this.events.length; i++) {
      this.starts.push(this.starts[i - 1] + segmentSeconds(this.events[i - 1], this.events[i], this.events[i].beat));
    }
  }

  static from(json: unknown): TempoMap {
    return new TempoMap(Array.isArray(json) ? (json as TempoEvent[]) : undefined);
  }

  toJSON(): TempoEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  // The event in effect at a beat (the first one before beat 0)
  eventAt(beat: number): TempoEvent {
    return this.events[lastAtOrBefore(this.beats, beat)];
  }

  bpmAt(beat: number): number {
    const i = lastAtOrBefore(this.beats, beat);
    const e0 = this.events[i], e1 = this.events[i + 1];
    const k = slope(e0, e1);
    return k === 0 || beat < e0.beat ? e0.bpm : e0.bpm + k * (beat - e0.beat);
  }

  secondsAt(beat: number): number {
    const first = this.events[0];
    if (beat < first.beat) return (60 * (beat - first.beat)) / first.bpm; // before the song: no ramp yet
    const i = lastAtOrBefore(this.beats, beat);
    return this.starts[i] + segmentSeconds(this.events[i], this.events[i + 1], beat);
  }

  beatAt(seconds: number): number {
    const first = this.events[0];
    if (seconds < 0) return first.beat + (seconds * first.bpm) / 60;
    const i = lastAtOrBefore(this.starts, seconds);
    return this.events[i].beat + segmentBeats(this.events[i], this.events[i + 1], seconds - this.starts[i]);
  }

  secondsBetween(fromBeat: number, toBeat: number): number {
    return this.secondsAt(toBeat) - this.secondsAt(fromBeat);
  }

  // The tempo in effect at `beat` set to `bpm`: the tempo field, the Tempo
  // Follower and a scene's tempo all edit the segment under the playhead
  withTempoAt(beat: number, bpm: number): TempoMap {
    const at = this.eventAt(beat).beat;
    return new TempoMap(this.events.map((e) => (e.beat === at ? { ...e, bpm } : e)));
  }

  withEvent(event: TempoEvent): TempoMap {
    return new TempoMap([...this.events.filter((e) => e.beat !== Math.max(0, event.beat)), event]);
  }

  // The event at beat 0 stays: a map always has one
  withoutEvent(beat: number): TempoMap {
    return beat <= 0 ? this : new TempoMap(this.events.filter((e) => e.beat !== beat));
  }
}
