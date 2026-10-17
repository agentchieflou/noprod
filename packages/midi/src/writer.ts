// writeMidiFile: a MidiFile's data as Standard MIDI File 1.0 bytes. Spec
// sections: 2.1 (the MThd chunk), 2.2 (MTrk chunks), 4 (delta times as
// variable-length quantities, running status, meta events: Track Name 03,
// Marker 06, End of Track 2F, Set Tempo 51, Time Signature 58, Key
// Signature 59).

import type { MidiFileData, MidiTrack, WriteOptions } from './types.ts';

const DEFAULT_TICKS_PER_BEAT = 960;
const MAX_TICK = 0x0fffffff;          // the largest variable-length quantity

interface Event {
  tick: number;
  order: number;                      // at one tick: note-offs, then meta, then the rest, then note-ons
  bytes: number[];                    // status first; a meta event whole
}

const OFF = 0, META = 1, PROGRAM = 2, CONTROLLER = 3, BEND = 4, PRESSURE = 5, ON = 6;

function integer(what: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${what} must be an integer from ${min} to ${max}, not ${value}`);
  return value;
}

function tickOf(what: string, beat: number, ticksPerBeat: number): number {
  if (!Number.isFinite(beat) || beat < 0) throw new RangeError(`${what} must be a position in beats from 0, not ${beat}`);
  const tick = Math.round(beat * ticksPerBeat);
  if (tick > MAX_TICK) throw new RangeError(`${what} of ${beat} beats does not fit a MIDI file at ${ticksPerBeat} ticks per beat`);
  return tick;
}

function vlq(value: number): number[] {
  const out = [value & 0x7f];
  for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

// Appended in a loop: spreading a megabyte of text into arguments overflows the stack
function append(into: number[], bytes: ArrayLike<number>) {
  for (let i = 0; i < bytes.length; i++) into.push(bytes[i]);
}

function meta(type: number, data: ArrayLike<number>): number[] {
  const out = [0xff, type];
  append(out, vlq(data.length));
  append(out, data);
  return out;
}
const textMeta = (type: number, text: string) => meta(type, new TextEncoder().encode(text));

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

function trackEvents(track: MidiTrack, ticksPerBeat: number): Event[] {
  const events: Event[] = [];
  const at = (what: string, beat: number) => tickOf(what, beat, ticksPerBeat);
  if (track.name) events.push({ tick: 0, order: -1, bytes: textMeta(0x03, track.name) });
  for (const n of track.notes) {
    const pitch = integer('a note\'s pitch', n.pitch, 0, 127), channel = integer('a note\'s channel', n.channel, 0, 15);
    if (!(n.velocity >= 0 && n.velocity <= 1)) throw new RangeError(`a note's velocity must be from 0 to 1, not ${n.velocity}`);
    if (!(n.length >= 0 && Number.isFinite(n.length))) throw new RangeError(`a note's length must be 0 or more beats, not ${n.length}`);
    const start = at('a note\'s start', n.start);
    const end = Math.max(start + 1, at('a note\'s end', n.start + n.length));   // never shorter than a tick
    events.push({ tick: start, order: ON, bytes: [0x90 | channel, pitch, Math.max(1, Math.round(n.velocity * 127))] });
    // A velocity 0 note-on is the common note-off; a release velocity needs a real one
    events.push({
      tick: end, order: OFF,
      bytes: n.releaseVelocity === undefined ? [0x90 | channel, pitch, 0] : [0x80 | channel, pitch, Math.round(Math.min(1, Math.max(0, n.releaseVelocity)) * 127)],
    });
  }
  for (const c of track.controllers) {
    events.push({ tick: at('a controller\'s position', c.beat), order: CONTROLLER, bytes: [0xb0 | integer('a channel', c.channel, 0, 15), integer('a controller number', c.controller, 0, 127), integer('a controller value', c.value, 0, 127)] });
  }
  for (const b of track.pitchBend) {
    if (!(b.value >= -1 && b.value <= 1)) throw new RangeError(`a pitch bend must be from −1 to 1, not ${b.value}`);
    const v = Math.min(16383, Math.round(b.value * 8192) + 8192);
    events.push({ tick: at('a pitch bend\'s position', b.beat), order: BEND, bytes: [0xe0 | integer('a channel', b.channel, 0, 15), v & 0x7f, v >> 7] });
  }
  for (const p of track.programs) {
    events.push({ tick: at('a program change\'s position', p.beat), order: PROGRAM, bytes: [0xc0 | integer('a channel', p.channel, 0, 15), integer('a program', p.program, 0, 127)] });
  }
  for (const p of track.channelPressure) {
    events.push({ tick: at('a pressure event\'s position', p.beat), order: PRESSURE, bytes: [0xd0 | integer('a channel', p.channel, 0, 15), integer('a pressure value', p.value, 0, 127)] });
  }
  return events;
}

// Tempo, meter, key and markers: they go in track 0
function conductorEvents(file: MidiFileData, ticksPerBeat: number): Event[] {
  const events: Event[] = [];
  for (const t of file.tempo ?? []) {
    if (!(t.bpm > 0 && Number.isFinite(t.bpm))) throw new RangeError(`a tempo must be above 0 BPM, not ${t.bpm}`);
    const us = Math.min(0xffffff, Math.max(1, Math.round(60e6 / t.bpm)));
    events.push({ tick: tickOf('a tempo\'s position', t.beat, ticksPerBeat), order: META, bytes: meta(0x51, [us >> 16, (us >> 8) & 0xff, us & 0xff]) });
  }
  // A signature sits on its bar line: bars to beats, walking the signatures
  let current = { numerator: 4, denominator: 4 }, baseBar = 0, baseBeat = 0;
  for (const m of [...(file.meter ?? [])].sort((a, b) => a.bar - b.bar)) {
    integer('a bar', m.bar, 0, MAX_TICK);
    integer('a time signature\'s numerator', m.numerator, 1, 64);
    const exponent = Math.log2(m.denominator);
    if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw new RangeError(`a time signature's denominator must be 1, 2, 4, 8, 16, 32 or 64, not ${m.denominator}`);
    baseBeat += (m.bar - baseBar) * ((current.numerator * 4) / current.denominator);
    baseBar = m.bar;
    current = m;
    // 24 MIDI clocks per click and 8 thirty-second notes per quarter: the spec's defaults
    events.push({ tick: tickOf('a time signature\'s position', baseBeat, ticksPerBeat), order: META, bytes: meta(0x58, [m.numerator, exponent, 24, 8]) });
  }
  for (const k of file.key ?? []) {
    events.push({ tick: tickOf('a key signature\'s position', k.beat, ticksPerBeat), order: META, bytes: meta(0x59, [integer('a key\'s sharps', k.sharps, -7, 7) & 0xff, k.minor ? 1 : 0]) });
  }
  for (const m of file.markers ?? []) {
    events.push({ tick: tickOf('a marker\'s position', m.beat, ticksPerBeat), order: META, bytes: textMeta(0x06, m.text) });
  }
  return events;
}

// One MTrk chunk: delta times, running status, and an End of Track at the last event
function trackChunk(events: Event[]): number[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.e.order - b.e.order || a.i - b.i);
  const body: number[] = [];
  let tick = 0, status = -1;
  for (const { e } of sorted) {
    append(body, vlq(e.tick - tick));
    tick = e.tick;
    const first = e.bytes[0];
    if (first >= 0xf0) {
      status = -1;   // meta events cancel running status (§4)
      append(body, e.bytes);
    } else {
      for (let i = first === status ? 1 : 0; i < e.bytes.length; i++) body.push(e.bytes[i]);
      status = first;
    }
  }
  body.push(0, 0xff, 0x2f, 0);
  return ['M', 'T', 'r', 'k'].map((c) => c.charCodeAt(0)).concat(u32(body.length), body);
}

export function writeMidiFile(file: MidiFileData, options: WriteOptions = {}): Uint8Array {
  const format = options.format ?? 1;
  if (format !== 0 && format !== 1) throw new RangeError(`format must be 0 or 1, not ${format}`);
  const ticksPerBeat = integer('ticksPerBeat', options.ticksPerBeat ?? DEFAULT_TICKS_PER_BEAT, 1, 0x7fff);

  const conductor = conductorEvents(file, ticksPerBeat);
  const tracks = file.tracks.length ? file.tracks : [{ name: '', notes: [], controllers: [], pitchBend: [], programs: [], channelPressure: [] }];
  const chunks = format === 0
    // One chunk: every track's events together, the channel on each telling them apart
    ? [trackChunk([...conductor, ...tracks.flatMap((t, i) => trackEvents(i ? { ...t, name: '' } : t, ticksPerBeat))])]
    : tracks.map((t, i) => trackChunk([...(i ? [] : conductor), ...trackEvents(t, ticksPerBeat)]));
  integer('the number of tracks', chunks.length, 1, 0xffff);

  const header = ['M', 'T', 'h', 'd'].map((c) => c.charCodeAt(0)).concat(u32(6), u16(format), u16(chunks.length), u16(ticksPerBeat));
  return Uint8Array.from(header.concat(...chunks));
}
