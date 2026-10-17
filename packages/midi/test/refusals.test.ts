import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, MidiFileError, MAX_FILE_BYTES, MAX_TRACKS, MAX_EVENTS, MAX_BEATS } from '../src/index.ts';
import { smf, track, ev, chunk, header, END, vlq } from './helpers.ts';

const refuses = (bytes: Uint8Array | number[], message: RegExp, offset?: number) =>
  assert.throws(() => readMidiFile(Uint8Array.from(bytes)), (e: unknown) => {
    assert.ok(e instanceof MidiFileError, `${e}`);
    assert.match(e.message, message);
    assert.match(e.message, /at byte \d+/);
    if (offset !== undefined) assert.equal(e.offset, offset);
    return true;
  });

const note = [ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0)];

test('not a MIDI file', () => {
  refuses([], /no MThd/, 0);
  refuses([1, 2, 3], /too short/, 0);
  refuses(chunk('MTrk', END), /no MThd/, 0);
});

test('a chunk length past the end of the file', () => {
  const ok = smf(0, 96, [track(note)]);
  refuses(ok.subarray(0, ok.length - 1), /chunk length runs past the end of the file/, 18);
  refuses([...header(0, 1, 96), ...'MTrk'.split('').map((c) => c.charCodeAt(0)), 0xff, 0xff, 0xff, 0xff, 0], /chunk length runs past/);
});

test('an MThd length under 6', () => {
  refuses([...chunk('MThd', [0, 0, 0, 1]), ...track(note)], /MThd length under 6/, 4);
});

test('an MThd longer than 6 is skipped past', () => {
  const bytes = [...chunk('MThd', [0, 0, 0, 1, 0, 96, 9, 9]), ...track(note)];
  assert.equal(readMidiFile(Uint8Array.from(bytes)).tracks[0].notes.length, 1);
});

test('0 tracks, and more declared than present', () => {
  refuses(header(1, 0, 96), /0 tracks/);
  refuses([...header(1, 3, 96), ...track(note), ...chunk('XXXX', [1])], /3 tracks declared but 1 chunks present/);
});

test('an unknown format, a division of 0, an unknown SMPTE rate', () => {
  refuses(smf(3, 96, [track(note)]), /unknown format 3/);
  refuses(smf(0, 0, [track(note)]), /division of 0/);
  refuses(smf(0, 0xe128, [track(note)]), /unknown SMPTE/);   // 0xe1 is −31 frames per second
  refuses(smf(0, 0xe200, [track(note)]), /0 ticks per frame/);   // −30, with none
});

test('a variable-length quantity longer than 4 bytes', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0x81, 0x81, 0x81, 0x81, 0x01, 0x90, 60, 100, ...END])]), /longer than 4 bytes/, 22);
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xff, 1, 0x81, 0x81, 0x81, 0x81, 0x01, ...END])]), /longer than 4 bytes/);
});

test('a variable-length quantity cut off by its chunk', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0x81])]), /runs past the end of its track/);
});

test('running status with no status before it', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0, 60, 100, ...END])]), /running status with no status before it/, 23);
});

test('a data byte ≥ 0x80 where a data byte belongs', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0, 0x90, 60, 0x85, ...END])]), /data byte ≥ 0x80/, 25);
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xc0, 0x85, ...END])]), /data byte ≥ 0x80/, 24);
});

test('a channel event cut off by its chunk', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0, 0x90, 60])]), /runs past the end of its track/);
  refuses(smf(0, 96, [chunk('MTrk', [0])]), /delta time with no event/);
});

test('a meta or sysex length past the chunk', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xff, 0x01, 5, 0x68, 0x69])]), /meta event length runs past/, 26);
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xf0, 9, 1, 2])]), /sysex length runs past/, 25);
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xf7, 9, 1, 2])]), /sysex length runs past/);
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xff])]), /meta event with no type/);
  // the chunk after it holds the bytes, but the length may not reach into them
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xff, 0x01, 4, 0x68]), chunk('MTrk', [1, 2, 3, ...END])]), /meta event length runs past/);
});

test('a status byte that does not belong in a file', () => {
  refuses(smf(0, 96, [chunk('MTrk', [0, 0xf8, ...END])]), /does not belong in a file/);
});

// The limits, each at and past
const tracks = (n: number) => smf(1, 96, Array.from({ length: n }, () => track([])));

test(`limit: ${MAX_TRACKS} tracks`, () => {
  assert.equal(readMidiFile(tracks(MAX_TRACKS)).tracks.length, MAX_TRACKS);
  refuses(tracks(MAX_TRACKS + 1), /more than 1024 tracks/);
});

test('limit: a declared track count is never allocated', () => {
  refuses(Uint8Array.from([...header(1, 65535, 96), ...track(note)]), /65535 tracks|more than 1024/);
});

// 2-byte events: a delta of 0 and a value, in running status after the first
const pressure = (n: number) => [0, 0xd0, 1, ...Array.from({ length: n - 1 }, () => [0, 1]).flat()];

test(`limit: ${MAX_EVENTS} events in all`, () => {
  const atLimit = readMidiFile(smf(0, 96, [chunk('MTrk', [...pressure(MAX_EVENTS - 1), ...END])]));   // the End of Track is an event
  assert.equal(atLimit.tracks[0].channelPressure.length, MAX_EVENTS - 1);
  refuses(smf(0, 96, [chunk('MTrk', [...pressure(MAX_EVENTS), ...END])]), /more than 2000000 events/);
});

test('limit: events are counted across tracks', () => {
  const half = (n: number) => chunk('MTrk', [...pressure(n), ...END]);
  assert.equal(readMidiFile(smf(1, 96, [half(MAX_EVENTS / 2 - 1), half(MAX_EVENTS / 2 - 1)])).tracks.length, 2);
  refuses(smf(1, 96, [half(MAX_EVENTS / 2 - 1), half(MAX_EVENTS / 2)]), /more than 2000000 events/);
});

test(`limit: ${MAX_FILE_BYTES / 1024 / 1024} MB of file`, () => {
  const base = smf(0, 96, [track(note)]);
  const padded = (size: number) => {
    const out = new Uint8Array(size);
    out.set(base);
    out.set(['J', 'U', 'N', 'K'].map((c) => c.charCodeAt(0)), base.length);
    new DataView(out.buffer).setUint32(base.length + 4, size - base.length - 8);
    return out;
  };
  assert.equal(readMidiFile(padded(MAX_FILE_BYTES)).tracks[0].notes.length, 1);
  refuses(padded(MAX_FILE_BYTES + 1), /larger than 64 MB/, 0);
});

test(`limit: a song of ${MAX_BEATS} beats`, () => {
  const at = (ticks: number) => smf(0, 96, [chunk('MTrk', [...ev(ticks, 0xb0, 1, 1), ...END])]);
  assert.equal(readMidiFile(at(MAX_BEATS * 96)).tracks[0].controllers[0].beat, MAX_BEATS);
  refuses(at(MAX_BEATS * 96 + 1), /past 100000 beats/, 22);
  refuses(smf(0, 96, [chunk('MTrk', [...vlq(0x0fffffff), 0xb0, 1, 1, ...END])]), /past 100000 beats/);
});

test('limit: a song of 100000 beats under SMPTE division', () => {
  // 1000 ticks a second, 120 BPM: a beat is 500 ticks
  const at = (ticks: number) => smf(0, 0xe728, [chunk('MTrk', [...ev(ticks, 0xb0, 1, 1), ...END])]);
  assert.equal(readMidiFile(at(MAX_BEATS * 500)).tracks[0].controllers[0].beat, MAX_BEATS);
  refuses(at(MAX_BEATS * 500 + 1), /past 100000 beats/, 22);
});
