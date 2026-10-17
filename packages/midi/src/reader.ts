// readMidiFile: Standard MIDI Files 1.0 (RP-001) into beats.
//
// A file is untrusted. Every read is bounded by the chunk it is in, nothing
// is sized by a declared length, and every refusal is a MidiFileError with
// the byte offset. Spec sections: 2 (chunks, §2.1 the header, §2.2 tracks),
// 3 (the header's format and division), 4 (track events: delta times as
// variable-length quantities, running status, sysex, meta events).

import { MidiFileError } from './errors.ts';
import type { MidiFile, MidiNote, MidiTrack } from './types.ts';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TRACKS = 1024;
export const MAX_EVENTS = 2_000_000;
export const MAX_BEATS = 100_000;

// TempoMap's range: a Set Tempo outside it is clamped, so the data is usable as is
const MIN_BPM = 20, MAX_BPM = 999;
const DEFAULT_BPM = 120;

const err = (message: string, offset: number) => new MidiFileError(message, offset);

interface Context {
  warn(message: string): void;
  events: number;
  maxTicks: number;
}

interface Parsed {
  track: MidiTrack;             // positions still in ticks
  tempo: { tick: number; us: number }[];
  meter: { tick: number; numerator: number; denominator: number }[];
  key: { tick: number; sharps: number; minor: boolean }[];
  markers: { tick: number; text: string }[];
  endTick: number;
  endOffset: number;            // where the last event starts
}

// Text metas are latin-1 in older files and UTF-8 in newer ones
function text(d: Uint8Array, from: number, to: number): string {
  const bytes = d.subarray(from, to);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

function parseTrack(d: Uint8Array, start: number, end: number, ctx: Context): Parsed {
  const track: MidiTrack = { name: '', notes: [], controllers: [], pitchBend: [], programs: [], channelPressure: [] };
  const out: Parsed = { track, tempo: [], meter: [], key: [], markers: [], endTick: 0, endOffset: start };
  // Open notes by channel and pitch, oldest first: a note-off ends the oldest
  const open = new Map<number, { notes: MidiNote[]; head: number }>();
  let named = false, ended = false;
  let p = start, tick = 0, running = -1;

  const vlq = (): number => {
    const at = p;
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= end) throw err('variable-length quantity runs past the end of its track', at);
      const b = d[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw err('variable-length quantity longer than 4 bytes', at);
  };

  while (p < end && !ended) {
    const eventAt = p;
    const delta = vlq();
    tick += delta;
    if (tick > ctx.maxTicks) throw err(`the song runs past ${MAX_BEATS} beats`, eventAt);
    if (++ctx.events > MAX_EVENTS) throw err(`more than ${MAX_EVENTS} events in the file`, eventAt);
    if (p >= end) throw err('delta time with no event after it', p);
    out.endTick = tick;
    if (delta) out.endOffset = eventAt;   // the event that got to the last tick

    let status = d[p];
    if (status >= 0x80) {
      p++;
      running = status < 0xf0 ? status : -1;   // sysex and meta events cancel running status (§4)
    } else {
      if (running < 0) throw err('running status with no status before it', p);
      status = running;
    }

    if (status < 0xf0) {
      const kind = status & 0xf0, channel = status & 0x0f;
      const count = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      if (p + count > end) throw err('channel event runs past the end of its track', p);
      for (let i = 0; i < count; i++) {
        if (d[p + i] >= 0x80) throw err('data byte ≥ 0x80 where a data byte belongs', p + i);
      }
      const a = d[p], b = count === 2 ? d[p + 1] : 0;
      p += count;
      if (kind === 0x90 && b > 0) {
        const note: MidiNote = { pitch: a, start: tick, length: 0, velocity: b / 127, channel };
        track.notes.push(note);
        const key = (channel << 7) | a;
        const queue = open.get(key);
        if (queue) queue.notes.push(note); else open.set(key, { notes: [note], head: 0 });
        continue;
      }
      if (kind === 0x80 || kind === 0x90) {   // a note-on with velocity 0 is a note-off (§4)
        const queue = open.get((channel << 7) | a);
        const note = queue && queue.head < queue.notes.length ? queue.notes[queue.head++] : undefined;
        if (!note) { ctx.warn('a note-off with no note-on before it was ignored'); continue; }
        note.length = Math.max(tick - note.start, 1);
        if (kind === 0x80) note.releaseVelocity = b / 127;
        continue;
      }
      switch (kind) {
        case 0xb0: track.controllers.push({ beat: tick, channel, controller: a, value: b }); break;
        case 0xc0: track.programs.push({ beat: tick, channel, program: a }); break;
        case 0xd0: track.channelPressure.push({ beat: tick, channel, value: a }); break;
        case 0xe0: track.pitchBend.push({ beat: tick, channel, value: ((b << 7) | a) / 8192 - 1 }); break;
        // 0xa0, polyphonic pressure: read and not kept
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = vlq();
      if (length > end - p) throw err('sysex length runs past its track chunk', p);
      p += length;
      continue;
    }
    if (status !== 0xff) throw err(`status byte 0x${status.toString(16)} does not belong in a file`, p - 1);

    if (p >= end) throw err('meta event with no type', p);
    const type = d[p++];
    const length = vlq();
    if (length > end - p) throw err('meta event length runs past its track chunk', p);
    const at = p;
    p += length;
    switch (type) {
      case 0x2f:
        if (length) ctx.warn('an End of Track with data was read as one without');
        ended = true;
        break;
      case 0x51: {
        if (length !== 3) { ctx.warn('a Set Tempo that is not 3 bytes long was ignored'); break; }
        const us = (d[at] << 16) | (d[at + 1] << 8) | d[at + 2];
        if (us === 0) ctx.warn('a Set Tempo of 0 microseconds was ignored'); else out.tempo.push({ tick, us });
        break;
      }
      case 0x58: {
        const numerator = d[at], exponent = d[at + 1];
        if (length < 2 || numerator < 1 || numerator > 64 || exponent > 6) {
          ctx.warn('a Time Signature outside 1..64 over 1..64 was ignored');
        } else {
          out.meter.push({ tick, numerator, denominator: 2 ** exponent });
        }
        break;
      }
      case 0x59: {
        const sharps = (d[at] << 24) >> 24;
        if (length !== 2 || sharps < -7 || sharps > 7 || d[at + 1] > 1) ctx.warn('a malformed Key Signature was ignored');
        else out.key.push({ tick, sharps, minor: d[at + 1] === 1 });
        break;
      }
      case 0x06: out.markers.push({ tick, text: text(d, at, at + length) }); break;
      case 0x03:
        if (!named) { track.name = text(d, at, at + length); named = true; }
        break;
      // Everything else (text, lyrics, cue points, channel prefix, port, SMPTE offset, sequencer-specific) is read and not kept
    }
  }

  if (!ended) ctx.warn('a track has no End of Track');
  else if (p < end) ctx.warn('bytes after a track\'s End of Track were ignored');

  // A note never released ends at its track's last event
  for (const queue of open.values()) {
    for (let i = queue.head; i < queue.notes.length; i++) {
      queue.notes[i].length = Math.max(out.endTick - queue.notes[i].start, 1);
      ctx.warn('a note with no note-off ends at the end of its track');
    }
  }
  return out;
}

export function readMidiFile(bytes: Uint8Array): MidiFile {
  const d = bytes;
  if (d.length > MAX_FILE_BYTES) throw err(`the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, 0);
  const warnings = new Set<string>();
  const ctx: Context = { warn: (m) => { warnings.add(m); }, events: 0, maxTicks: Infinity };

  // §2: a file is chunks, each a 4-character type and a 32-bit length. They are
  // walked one at a time and only the tracks are kept, so a file of a million
  // empty unknown chunks costs the loop and nothing else
  const lengthAt = (p: number): number => {
    const length = d[p + 4] * 0x1000000 + ((d[p + 5] << 16) | (d[p + 6] << 8) | d[p + 7]);
    if (length > d.length - p - 8) throw err('chunk length runs past the end of the file', p + 4);
    return length;
  };
  const isType = (p: number, a: number, b: number, c: number, e: number) => d[p] === a && d[p + 1] === b && d[p + 2] === c && d[p + 3] === e;
  if (d.length && d.length < 8) throw err('not a MIDI file: too short for a chunk header', 0);
  if (!d.length || !isType(0, 0x4d, 0x54, 0x68, 0x64)) throw err('not a MIDI file: no MThd header chunk', 0);
  const head = { start: 8, end: 8 + lengthAt(0) };

  // §2.1 / §3: format, number of tracks, division. A header longer than 6 is skipped past
  if (head.end - head.start < 6) throw err('MThd length under 6', 4);
  const format = (d[head.start] << 8) | d[head.start + 1];
  const declared = (d[head.start + 2] << 8) | d[head.start + 3];
  const division = (d[head.start + 4] << 8) | d[head.start + 5];
  if (format > 2) throw err(`unknown format ${format}`, head.start);
  if (declared === 0) throw err('the file declares 0 tracks', head.start + 2);
  if (declared > MAX_TRACKS) throw err(`the file declares more than ${MAX_TRACKS} tracks`, head.start + 2);

  if (format === 0 && declared !== 1) ctx.warn('a format 0 file with more than one track');
  if (format === 2) ctx.warn('format 2 (independent patterns): each track is read from beat 0');

  // §3: a division with the high bit set is frames per second and ticks per frame
  const smpte = (division & 0x8000) !== 0;
  let ticksPerBeat = division;
  let ticksPerSecond = 0;
  if (smpte) {
    const code = 256 - (division >> 8);
    const fps = code === 29 ? 29.97 : code;
    if (![24, 25, 29.97, 30].includes(fps)) throw err(`unknown SMPTE format -${code}`, head.start + 4);
    const perFrame = division & 0xff;
    if (!perFrame) throw err('SMPTE division with 0 ticks per frame', head.start + 5);
    ticksPerSecond = fps * perFrame;
  } else {
    if (!division) throw err('division of 0 ticks per beat', head.start + 4);
    ctx.maxTicks = MAX_BEATS * ticksPerBeat;
  }

  const parsed: Parsed[] = [];
  for (let p = head.end; p < d.length;) {
    if (d.length - p < 8) { ctx.warn('bytes after the last chunk were ignored'); break; }
    const end = p + 8 + lengthAt(p);
    if (isType(p, 0x4d, 0x54, 0x72, 0x6b)) {   // unknown chunk types are skipped (§2)
      if (parsed.length < declared) parsed.push(parseTrack(d, p + 8, end, ctx));
      else ctx.warn('tracks beyond the number in the header were ignored');
    }
    p = end;
  }
  if (parsed.length < declared) throw err(`${declared} tracks declared but ${parsed.length} chunks present`, d.length);

  const byTick = <T extends { tick: number }>(all: T[]) => all.sort((a, b) => a.tick - b.tick);   // stable: track order breaks ties
  const tempoEvents = byTick(parsed.flatMap((t) => t.tempo));
  const bpmOf = (us: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, 60e6 / us));

  if (smpte) {
    // Ticks are seconds here: beats need a tempo, the file's first or 120 BPM
    const bpm = tempoEvents.length ? bpmOf(tempoEvents[0].us) : DEFAULT_BPM;
    ticksPerBeat = (ticksPerSecond * 60) / bpm;
    ctx.warn(`SMPTE division: positions converted to beats at ${bpm} BPM`);
    for (const t of parsed) {
      if (t.endTick / ticksPerBeat > MAX_BEATS) throw err(`the song runs past ${MAX_BEATS} beats`, t.endOffset);
    }
  }
  const beat = (tick: number) => tick / ticksPerBeat;

  const tempo: MidiFile['tempo'] = [];
  // Under SMPTE the positions were converted at the first tempo, so it is the only one
  if (smpte && tempoEvents.length) {
    if (tempoEvents.length > 1) ctx.warn('SMPTE division: Set Tempo events after the first were dropped');
    tempo.push({ beat: 0, bpm: bpmOf(tempoEvents[0].us) });
  } else for (const e of tempoEvents) {
    const entry = { beat: beat(e.tick), bpm: bpmOf(e.us) };
    if (tempo.length && tempo[tempo.length - 1].beat === entry.beat) tempo[tempo.length - 1] = entry; else tempo.push(entry);
  }
  if (!tempo.length || (!smpte && tempo[0].beat > 0)) tempo.unshift({ beat: 0, bpm: DEFAULT_BPM });

  // Signatures are by bar, and a bar line is where a signature can change
  const meter: MidiFile['meter'] = [];
  let current = { numerator: 4, denominator: 4 }, baseBar = 0, baseBeat = 0;
  for (const e of byTick(parsed.flatMap((t) => t.meter))) {
    const length = (current.numerator * 4) / current.denominator;
    const bars = (beat(e.tick) - baseBeat) / length;
    if (Math.abs(bars - Math.round(bars)) > 1e-9) ctx.warn('a Time Signature in the middle of a bar moved to the next bar line');
    const whole = Math.max(0, Math.ceil(bars - 1e-9));
    const entry = { bar: baseBar + whole, numerator: e.numerator, denominator: e.denominator };
    if (meter.length && meter[meter.length - 1].bar === entry.bar) meter[meter.length - 1] = entry; else meter.push(entry);
    current = entry;
    baseBeat += whole * length;
    baseBar = entry.bar;
  }
  if (!meter.length || meter[0].bar > 0) meter.unshift({ bar: 0, numerator: 4, denominator: 4 });

  const keys = byTick(parsed.flatMap((t) => t.key)).map((e) => ({ beat: beat(e.tick), sharps: e.sharps, minor: e.minor }));
  const markers = byTick(parsed.flatMap((t) => t.markers)).map((e) => ({ beat: beat(e.tick), text: e.text }));

  const tracks = parsed.map(({ track }) => {
    for (const n of track.notes) { n.start = beat(n.start); n.length = beat(n.length); }
    for (const list of [track.controllers, track.pitchBend, track.programs, track.channelPressure]) {
      for (const e of list) e.beat = beat(e.beat);
    }
    return track;
  });

  return {
    format: format as 0 | 1 | 2,
    ticksPerBeat,
    tempo,
    meter,
    ...(keys.length ? { key: keys } : {}),
    markers,
    tracks,
    warnings: [...warnings],
  };
}
