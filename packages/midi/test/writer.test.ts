import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, writeMidiFile } from '../src/index.ts';
import type { MidiTrack } from '../src/index.ts';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const empty = (name = ''): MidiTrack => ({ name, notes: [], controllers: [], pitchBend: [], programs: [], channelPressure: [] });

test('one small file\'s exact bytes, against the spec\'s layout', () => {
  const bytes = writeMidiFile({
    tempo: [{ beat: 0, bpm: 120 }],
    meter: [{ bar: 0, numerator: 4, denominator: 4 }],
    tracks: [{ ...empty('A'), notes: [{ pitch: 60, start: 0, length: 1, velocity: 100 / 127, channel: 0 }] }],
  }, { ticksPerBeat: 96 });
  assert.equal(hex(bytes), [
    '4d 54 68 64  00 00 00 06  00 01  00 01  00 60',     // MThd: length 6, format 1, 1 track, 96 ticks per quarter (§2.1)
    '4d 54 72 6b  00 00 00 1f',                          // MTrk, 31 bytes (§2.2)
    '00 ff 03 01 41',                                    // delta 0, Track Name "A"
    '00 ff 51 03 07 a1 20',                              // Set Tempo 500000 µs per quarter
    '00 ff 58 04 04 02 18 08',                           // Time Signature 4/4 (denominator 2²), 24 clocks, 8 32nds
    '00 90 3c 64',                                       // note-on, channel 0, middle C, velocity 100
    '60 3c 00',                                          // delta 96 (0x60), running status: note-off as velocity 0
    '00 ff 2f 00',                                       // End of Track
  ].join(' ').replace(/ {2}/g, ' '));
});

test('format 0 writes one track with the channel on each event', () => {
  const bytes = writeMidiFile({
    tracks: [
      { ...empty('A'), notes: [{ pitch: 60, start: 0, length: 1, velocity: 1, channel: 2 }] },
      { ...empty('B'), notes: [{ pitch: 62, start: 0.5, length: 1, velocity: 1, channel: 3 }] },
    ],
  }, { format: 0, ticksPerBeat: 96 });
  const file = readMidiFile(bytes);
  assert.equal(file.format, 0);
  assert.equal(file.tracks.length, 1);
  assert.deepEqual(file.tracks[0].notes.map((n) => [n.pitch, n.channel, n.start]), [[60, 2, 0], [62, 3, 0.5]]);
});

test('note-offs come before note-ons at the same tick', () => {
  const file = readMidiFile(writeMidiFile({
    tracks: [{ ...empty(), notes: [
      { pitch: 60, start: 1, length: 1, velocity: 1, channel: 0 },
      { pitch: 60, start: 0, length: 1, velocity: 0.5, channel: 0 },
    ] }],
  }, { ticksPerBeat: 96 }));
  // If the second note's on came first, the first off would close the wrong note
  assert.deepEqual(file.tracks[0].notes.map((n) => [n.start, n.length]), [[0, 1], [1, 1]]);
  assert.deepEqual(file.warnings, []);
});

test('positions round to the nearest tick, and no note is shorter than one', () => {
  const [a, b] = readMidiFile(writeMidiFile({
    tracks: [{ ...empty(), notes: [
      { pitch: 60, start: 0.2, length: 0, velocity: 1, channel: 0 },          // 0.2 · 10 = 2 ticks
      { pitch: 61, start: 0.26, length: 0.04, velocity: 1, channel: 0 },      // 2.6 → 3, and 0.3 · 10 → 3: zero ticks long
    ] }],
  }, { ticksPerBeat: 10 })).tracks[0].notes;
  assert.deepEqual([a.start, a.length], [0.2, 0.1]);
  assert.deepEqual([b.start, b.length], [0.3, 0.1]);
});

test('refuses what a file cannot hold', () => {
  const note = (over: object) => ({ tracks: [{ ...empty(), notes: [{ pitch: 60, start: 0, length: 1, velocity: 1, channel: 0, ...over }] }] });
  assert.throws(() => writeMidiFile(note({ pitch: 128 })), RangeError);
  assert.throws(() => writeMidiFile(note({ channel: 16 })), RangeError);
  assert.throws(() => writeMidiFile(note({ velocity: 1.5 })), RangeError);
  assert.throws(() => writeMidiFile(note({ start: -1 })), RangeError);
  assert.throws(() => writeMidiFile(note({ start: 1e9 })), RangeError);
  assert.throws(() => writeMidiFile(note({}), { ticksPerBeat: 0 }), RangeError);
  assert.throws(() => writeMidiFile(note({}), { ticksPerBeat: 0x8000 }), RangeError);
  assert.throws(() => writeMidiFile(note({}), { format: 2 as never }), RangeError);
  assert.throws(() => writeMidiFile({ ...note({}), meter: [{ bar: 0, numerator: 4, denominator: 3 }] }), RangeError);
  assert.throws(() => writeMidiFile({ ...note({}), tempo: [{ beat: 0, bpm: 0 }] }), RangeError);
});
