// Accompaniment: a bass line and a comping part that follow the chords
// played live. A style is data: a bar of hits, each a chord tone (the bass)
// or the whole chord (the keys), placed in beats. Which chord a hit plays
// is settled at the style's steps (every beat, every half bar…): the chord
// held there, else the last one played. The keys are voice-led from chord
// to chord, the bass moves to the nearest root.
//
// Everything is in beats from a clock the caller drives: `advance` commits
// the notes that start soon, and a chord change revises what's committed
// but hasn't sounded. Same notes and times in, same notes out.

import { CHORD_TYPES, recognizeChord, type ChordQuality } from './chords.ts';
import { fitRange, nearestPitch, pitchClasses } from './notes.ts';
import { voiceLead } from './voicing.ts';

export type BassTone = 'root' | 'third' | 'fifth' | 'sixth' | 'seventh' | 'octave';

export interface AccompanyHit {
  at: number;        // beats into the pattern
  length: number;    // beats
  tone: BassTone | 'chord';
  velocity: number;  // 0..1
}

export interface AccompanyStyle {
  id: string;
  name: string;
  description: string;
  step: number;      // beats: how often the chord may change
  bass: AccompanyHit[];   // one bar of four beats
  keys: AccompanyHit[];
  color?: Partial<Record<ChordQuality, ChordQuality>>;   // the chords as the style plays them (blues: C as C7)
}

// Hits `spacing` beats apart from `from`, one per velocity
const every = (spacing: number, length: number, tone: AccompanyHit['tone'], velocities: number[], from = 0): AccompanyHit[] =>
  velocities.map((velocity, i) => ({ at: from + i * spacing, length, tone, velocity }));

const SWING = 2 / 3;   // a shuffle's off-beat: the last third of the beat

export const ACCOMPANY_STYLES: AccompanyStyle[] = [
  {
    id: 'pop-eighths',
    name: 'Pop eighths',
    description: 'Driving eighth notes: the root in the bass, the chord on the keys',
    step: 1,
    bass: every(0.5, 0.45, 'root', [0.85, 0.65, 0.85, 0.65, 0.85, 0.65, 0.85, 0.65]),
    keys: every(0.5, 0.4, 'chord', [0.7, 0.5, 0.7, 0.5, 0.7, 0.5, 0.7, 0.5])
  },
  {
    id: 'ballad',
    name: 'Ballad',
    description: 'A sustained chord each bar over a root and fifth in the bass',
    step: 2,
    bass: [
      { at: 0, length: 2, tone: 'root', velocity: 0.8 },
      { at: 2, length: 2, tone: 'fifth', velocity: 0.65 }
    ],
    keys: [{ at: 0, length: 4, tone: 'chord', velocity: 0.6 }]
  },
  {
    id: 'shuffle',
    name: '12-bar shuffle',
    description: 'A swung boogie bass and stabs into beats 2 and 4, with 7th chords',
    step: 2,
    bass: (['root', 'third', 'fifth', 'sixth', 'seventh', 'sixth', 'fifth', 'third'] as BassTone[]).map((tone, i) => ({
      at: Math.floor(i / 2) + (i % 2) * SWING,
      length: (i % 2 ? 1 - SWING : SWING) * 0.9,
      tone,
      velocity: i % 2 ? 0.65 : 0.85
    })),
    keys: [1, 3].flatMap((beat) => [
      { at: beat - 1 + SWING, length: (1 - SWING) * 0.9, tone: 'chord' as const, velocity: 0.5 },
      { at: beat, length: 0.5, tone: 'chord' as const, velocity: 0.7 }
    ]),
    color: { maj: '7', min: 'm7' }
  }
];

export const findStyle = (id: string) => ACCOMPANY_STYLES.find((s) => s.id === id);

export interface AccompanyNote {
  id: number;
  part: 'bass' | 'keys';
  pitch: number;
  start: number;     // beats
  end: number;       // beats
  velocity: number;
}

// 'start': schedule the note. 'stop': it ends at `at` instead (at or before
// its start: it never sounds).
export type AccompanyEvent =
  | { type: 'start'; note: AccompanyNote }
  | { type: 'stop'; id: number; at: number };

export interface AccompanyOptions {
  beatsPerBar?: number;
  bassRange?: [number, number];
  keysRange?: [number, number];
}

// A change this soon after a step's start still takes the step: what
// sounded from the step's start is played again with the new chord
export const LATE_GRACE = 1 / 8;   // beats: a 32nd note

const EPSILON = 1e-9;

interface Voicing { root: number; quality: ChordQuality; keys: number[]; bass: number }

type Planned = Omit<AccompanyNote, 'id'>;

// How far above the root a bass tone is, for this kind of chord
function toneInterval(tone: BassTone, quality: ChordQuality) {
  const intervals = CHORD_TYPES[quality].intervals;
  switch (tone) {
    case 'root': return 0;
    case 'third': return intervals[1];   // sus chords: their 2nd or 4th; a power chord: its 5th
    case 'fifth': return intervals.find((i) => i >= 6 && i <= 8) ?? 7;
    case 'sixth': return 9;
    case 'seventh': return intervals.find((i) => i === 10 || i === 11) ?? (quality === 'dim7' ? 9 : 10);
    case 'octave': return 12;
  }
}

export class Accompanist {
  readonly style: AccompanyStyle;
  private readonly beatsPerBar: number;
  private readonly stepsPerBar: number;
  private readonly bassRange: [number, number];
  private readonly keysRange: [number, number];
  private readonly held = new Set<number>();
  private readonly changes: { at: number; root: number; quality: ChordQuality }[] = [];
  private readonly late: number[] = [];   // changes that came within LATE_GRACE of a step: steps of their own
  private readonly voicings = new Map<number, Voicing>();   // by the beat their step starts
  private readonly committed = new Map<number, AccompanyNote>();
  private horizon: number | null = null;   // notes starting before this are committed
  private nextId = 1;

  constructor(style: AccompanyStyle, options: AccompanyOptions = {}) {
    this.style = style;
    this.beatsPerBar = options.beatsPerBar ?? 4;
    this.stepsPerBar = Math.ceil(this.beatsPerBar / style.step - EPSILON);
    this.bassRange = options.bassRange ?? [28, 55];
    this.keysRange = options.keysRange ?? [52, 76];
  }

  // ------------------------------------------------------------- input

  // A chord is three or more pitch classes put down together. Only a key
  // pressed changes it: lifting a chord note by note leaves the chord as it was.
  noteOn(pitch: number, at: number): AccompanyEvent[] {
    this.held.add(pitch);
    const held = [...this.held];
    if (pitchClasses(held).length < 3) return [];
    const chord = recognizeChord(held);
    const last = this.changes[this.changes.length - 1];
    if (!chord || (last && last.root === chord.root && last.quality === chord.quality)) return [];
    const time = Math.max(at, last?.at ?? -Infinity);
    this.changes.push({ at: time, root: chord.root, quality: chord.quality });
    const step = this.regular(time);
    if (time - step > EPSILON && time - step <= LATE_GRACE + EPSILON) this.late.push(time);
    for (const beat of [...this.voicings.keys()]) if (beat >= time) this.voicings.delete(beat);
    return this.revise(time);
  }

  noteOff(pitch: number) {
    this.held.delete(pitch);
  }

  // The chord played at `beat` (as played, before the style colors it)
  chordAt(beat: number): { root: number; quality: ChordQuality } | null {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      if (this.changes[i].at <= beat) return { root: this.changes[i].root, quality: this.changes[i].quality };
    }
    return null;
  }

  // ------------------------------------------------------------ output

  // Commits the notes that start before `until`. The first call starts the
  // band at `now`.
  advance(now: number, until: number): AccompanyEvent[] {
    if (this.horizon === null) this.horizon = now;
    for (const [id, note] of this.committed) if (note.end <= now) this.committed.delete(id);
    if (until <= this.horizon) return [];
    const events = this.plan(this.horizon, until).map((n) => this.commit(n));
    this.horizon = until;
    return events;
  }

  // Everything stops at `now`
  stop(now: number): AccompanyEvent[] {
    const events: AccompanyEvent[] = [];
    for (const note of this.committed.values()) {
      if (note.end > now) events.push({ type: 'stop', id: note.id, at: Math.max(note.start, now) });
    }
    this.committed.clear();
    this.horizon = null;
    return events;
  }

  // Every note starting in [from, to), as things stand: the chords played
  // so far, the last of them held from here on
  plan(from: number, to: number): Planned[] {
    const notes: Planned[] = [];
    const { beatsPerBar } = this;
    // A hit ends with its bar, so the bars from `from`'s on
    for (let bar = Math.floor(from / beatsPerBar); bar * beatsPerBar < to; bar++) {
      const barStart = bar * beatsPerBar;
      for (const part of ['bass', 'keys'] as const) {
        for (const hit of this.style[part]) {
          if (hit.at >= beatsPerBar - EPSILON) continue;
          const start = barStart + hit.at;
          const end = Math.min(start + hit.length, barStart + beatsPerBar);
          if (end <= from || start >= to) continue;
          this.sound(part, hit, start, end, (pitch, s, e) => {
            if (s >= from && s < to) notes.push({ part, pitch, start: s, end: e, velocity: hit.velocity });
          });
        }
      }
    }
    return notes.sort((a, b) => a.start - b.start || (a.part === b.part ? a.pitch - b.pitch : a.part === 'bass' ? -1 : 1));
  }

  // A hit across the steps it spans: a pitch the next chord also has holds
  // on; the others stop there, and the new chord's own start there
  private sound(part: 'bass' | 'keys', hit: AccompanyHit, start: number, end: number, emit: (pitch: number, start: number, end: number) => void) {
    const open = new Map<number, number>();   // pitch → since
    for (let at = start, step = this.stepAt(start); at < end; at = this.after(at), step = at) {
      const voicing = this.voicing(step);
      const pitches = voicing ? this.pitches(part, hit.tone, voicing) : [];
      for (const [pitch, since] of open) {
        if (!pitches.includes(pitch)) { emit(pitch, since, at); open.delete(pitch); }
      }
      for (const pitch of pitches) if (!open.has(pitch)) open.set(pitch, at);
    }
    for (const [pitch, since] of open) emit(pitch, since, end);
  }

  private pitches(part: 'bass' | 'keys', tone: AccompanyHit['tone'], voicing: Voicing) {
    if (part === 'keys' || tone === 'chord') return voicing.keys;
    const pitch = voicing.bass + toneInterval(tone, voicing.quality);
    return [pitch > this.bassRange[1] ? pitch - 12 : pitch];
  }

  // ------------------------------------------------------------- steps

  private index(beat: number) {
    const bar = Math.floor(beat / this.beatsPerBar + EPSILON);
    const local = beat - bar * this.beatsPerBar;
    return bar * this.stepsPerBar + Math.min(this.stepsPerBar - 1, Math.floor(local / this.style.step + EPSILON));
  }

  private boundary(index: number) {
    const bar = Math.floor(index / this.stepsPerBar);
    return bar * this.beatsPerBar + (index - bar * this.stepsPerBar) * this.style.step;
  }

  // The style's own step at or before `beat`
  private regular(beat: number) {
    return this.boundary(this.index(beat));
  }

  // The step at or before `beat`, a late change's included
  private stepAt(beat: number) {
    let step = this.regular(beat);
    for (const t of this.late) if (t <= beat + EPSILON && t > step) step = t;
    return step;
  }

  // The next step after `beat`
  private after(beat: number) {
    let next = this.boundary(this.index(beat) + 1);
    for (const t of this.late) if (t > beat + EPSILON && t < next) next = t;
    return next;
  }

  // The step before the one starting at `step`
  private before(step: number) {
    const i = this.index(step);
    let previous = this.boundary(step - this.boundary(i) > EPSILON ? i : i - 1);
    for (const t of this.late) if (t < step - EPSILON && t > previous) previous = t;
    return previous;
  }

  // How the step starting at `step` is voiced, worked out from the last
  // step whose voicing is known (or the first chord)
  private voicing(step: number): Voicing | null {
    const todo: number[] = [];
    let known: Voicing | null = null;
    for (let at = step; ; at = this.before(at)) {
      const cached = this.voicings.get(at);
      if (cached) { known = cached; break; }
      if (!this.chordAt(at)) break;
      todo.push(at);
    }
    for (let i = todo.length - 1; i >= 0; i--) {
      known = this.voice(this.chordAt(todo[i])!, known);
      this.voicings.set(todo[i], known);
    }
    return known;
  }

  private voice(chord: { root: number; quality: ChordQuality }, previous: Voicing | null): Voicing {
    const quality = this.style.color?.[chord.quality] ?? chord.quality;
    if (previous && previous.root === chord.root && previous.quality === quality) return previous;
    const [low, high] = this.bassRange;
    const bass = fitRange(nearestPitch(chord.root, previous?.bass ?? 36), [low, high - 12]) ?? low;
    const keys = voiceLead(previous?.keys ?? [], chord.root, quality, this.keysRange);
    return { root: chord.root, quality, keys, bass };
  }

  // -------------------------------------------------------- committing

  private commit(planned: Planned): AccompanyEvent {
    const note = { id: this.nextId++, ...planned };
    this.committed.set(note.id, note);
    return { type: 'start', note };
  }

  // The chords from `from` on changed: take back what's committed and no
  // longer planned, shorten what's sounding, and commit the rest anew
  private revise(from: number): AccompanyEvent[] {
    if (this.horizon === null || from >= this.horizon) return [];
    const events: AccompanyEvent[] = [];
    const live = [...this.committed.values()].filter((n) => n.end > from);
    const plan = this.plan(Math.min(from, ...live.map((n) => n.start)), this.horizon);
    const used = new Set<Planned>();
    const same = (a: Planned, b: Planned) => a.part === b.part && a.pitch === b.pitch;

    // Not started: kept if planned just so, else taken back
    for (const note of live.filter((n) => n.start >= from)) {
      const planned = plan.find((p) => !used.has(p) && same(p, note) && p.start === note.start && p.end === note.end && p.velocity === note.velocity);
      if (planned) { used.add(planned); continue; }
      events.push({ type: 'stop', id: note.id, at: note.start });
      this.committed.delete(note.id);
    }
    // Sounding: the plan before `from` hasn't changed, so it holds the note
    for (const note of live.filter((n) => n.start < from)) {
      const planned = plan.find((p) => same(p, note) && p.start <= note.start && note.start < p.end);
      if (planned) used.add(planned);
      const end = planned?.end ?? from;
      if (end < note.end) {
        events.push({ type: 'stop', id: note.id, at: end });
        note.end = end;
      } else if (end > note.end) {
        // Stopped for a change taken back since: it sounds again from there
        events.push(this.commit({ ...planned!, start: note.end }));
      }
    }
    for (const p of plan) if (!used.has(p) && p.start >= from) events.push(this.commit(p));
    return events;
  }
}
