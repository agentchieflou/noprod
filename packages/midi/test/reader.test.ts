import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile } from '../src/index.ts';
import { TempoMap } from '../../time/src/index.ts';
import { smf, track, ev, tempoEv, meterEv, vlq } from './helpers.ts';

test('a minimal format 1 file reads as data in beats', () => {
  const file = readMidiFile(smf(1, 480, [
    track([tempoEv(0, 100), meterEv(0, 3, 2)]),
    track([ev(0, 0xff, 3, 4, 0x4c, 0x65, 0x61, 0x64), ev(0, 0x90, 60, 127), ev(480, 0x80, 60, 40)]),
  ]));
  assert.equal(file.format, 1);
  assert.equal(file.ticksPerBeat, 480);
  assert.deepEqual(file.tempo, [{ beat: 0, bpm: 100 }]);
  assert.deepEqual(file.meter, [{ bar: 0, numerator: 3, denominator: 4 }]);
  assert.equal(file.tracks[1].name, 'Lead');
  assert.deepEqual(file.tracks[1].notes, [{ pitch: 60, start: 0, length: 1, velocity: 1, channel: 0, releaseVelocity: 40 / 127 }]);
  assert.deepEqual(file.warnings, []);
  assert.equal(file.key, undefined);
});

test('defaults: 120 BPM and 4/4 when the file sets none', () => {
  const file = readMidiFile(smf(0, 96, [track([])]));
  assert.deepEqual(file.tempo, [{ beat: 0, bpm: 120 }]);
  assert.deepEqual(file.meter, [{ bar: 0, numerator: 4, denominator: 4 }]);
});

test('running status: later events leave the status byte out', () => {
  const file = readMidiFile(smf(0, 96, [track([
    ev(0, 0x91, 60, 100), ev(0, 62, 100),        // two note-ons on channel 1
    ev(96, 60, 0), ev(0, 62, 0),                 // ended with velocity 0, still running status
  ])]));
  assert.deepEqual(file.tracks[0].notes.map((n) => [n.pitch, n.channel, n.start, n.length]), [[60, 1, 0, 1], [62, 1, 0, 1]]);
  assert.deepEqual(file.warnings, []);
});

test('a meta event cancels running status', () => {
  assert.throws(() => readMidiFile(smf(0, 96, [track([ev(0, 0x90, 60, 100), ev(0, 0xff, 1, 0), ev(0, 60, 0)])])), /running status/);
});

test('a note-on with velocity 0 is a note-off, with no release velocity', () => {
  const [note] = readMidiFile(smf(0, 96, [track([ev(0, 0x90, 60, 90), ev(48, 0x90, 60, 0)])])).tracks[0].notes;
  assert.equal(note.length, 0.5);
  assert.equal(note.velocity, 90 / 127);
  assert.equal('releaseVelocity' in note, false);
});

test('overlapping notes of one pitch pair first in, first out', () => {
  const { notes } = readMidiFile(smf(0, 96, [track([
    ev(0, 0x90, 60, 50), ev(96, 0x90, 60, 100),   // A at 0, B at 1
    ev(96, 0x90, 60, 0),                           // the first off, at 2: ends A
    ev(96, 0x90, 60, 0),                           // the second, at 3: ends B
  ])])).tracks[0];
  assert.deepEqual(notes.map((n) => [n.velocity, n.start, n.length]), [[50 / 127, 0, 2], [100 / 127, 1, 2]]);
});

test('the same pitch on two channels pairs separately', () => {
  const { notes } = readMidiFile(smf(0, 96, [track([
    ev(0, 0x90, 60, 100), ev(0, 0x91, 60, 100), ev(96, 0x91, 60, 0), ev(96, 0x90, 60, 0),
  ])])).tracks[0];
  assert.deepEqual(notes.map((n) => [n.channel, n.length]), [[0, 2], [1, 1]]);
});

test('a note never released ends at its track\'s last event', () => {
  const file = readMidiFile(smf(0, 96, [track([ev(0, 0x90, 60, 100), ev(192, 0xb0, 7, 100)])]));
  assert.equal(file.tracks[0].notes[0].length, 2);
  assert.ok(file.warnings.some((w) => /no note-off/.test(w)));
});

test('a zero-length note keeps a length of one tick', () => {
  const [note] = readMidiFile(smf(0, 480, [track([ev(480, 0x90, 60, 100), ev(0, 0x90, 60, 0)])])).tracks[0].notes;
  assert.equal(note.start, 1);
  assert.equal(note.length, 1 / 480);
});

test('a stray note-off is ignored with one warning', () => {
  const file = readMidiFile(smf(0, 96, [track([ev(0, 0x80, 60, 0), ev(0, 0x80, 61, 0)])]));
  assert.deepEqual(file.tracks[0].notes, []);
  assert.equal(file.warnings.length, 1);
});

test('controllers, programs, pressure and bends keep their channel; polyphonic pressure is skipped', () => {
  const t = readMidiFile(smf(0, 96, [track([
    ev(0, 0xb2, 7, 99), ev(96, 0xc3, 5), ev(0, 0xd4, 77), ev(0, 0xa0, 60, 50),
    ev(0, 0xe5, 0, 64), ev(0, 0xe5, 0, 0), ev(0, 0xe5, 127, 127),
  ])])).tracks[0];
  assert.deepEqual(t.controllers, [{ beat: 0, channel: 2, controller: 7, value: 99 }]);
  assert.deepEqual(t.programs, [{ beat: 1, channel: 3, program: 5 }]);
  assert.deepEqual(t.channelPressure, [{ beat: 1, channel: 4, value: 77 }]);
  assert.deepEqual(t.pitchBend.map((b) => b.value), [0, -1, 16383 / 8192 - 1]);
});

test('sysex, escapes and unkept metas are skipped', () => {
  const file = readMidiFile(smf(0, 96, [track([
    ev(0, 0xf0, ...vlq(3), 1, 2, 0xf7), ev(0, 0xf7, ...vlq(2), 9, 9),
    ev(0, 0xff, 0x7f, 2, 1, 2), ev(0, 0xff, 0x01, 2, 0x68, 0x69),
    ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0),
  ])]));
  assert.equal(file.tracks[0].notes.length, 1);
  assert.deepEqual(file.warnings, []);
});

test('key signatures and markers, from any track, in time order', () => {
  const file = readMidiFile(smf(1, 96, [
    track([ev(96, 0xff, 0x06, 1, 0x42), ev(0, 0xff, 0x59, 2, 0xfd, 1)]),   // 3 flats, minor
    track([ev(0, 0xff, 0x06, 1, 0x41)]),
  ]));
  assert.deepEqual(file.markers, [{ beat: 0, text: 'A' }, { beat: 1, text: 'B' }]);
  assert.deepEqual(file.key, [{ beat: 1, sharps: -3, minor: true }]);
});

test('text is UTF-8 when it is, latin-1 when it is not', () => {
  const file = readMidiFile(smf(0, 96, [track([ev(0, 0xff, 3, 3, 0x63, 0xc3, 0xa9), ev(0, 0xff, 6, 2, 0x63, 0xe9)])]));
  assert.equal(file.tracks[0].name, 'cé');
  assert.equal(file.markers[0].text, 'cé');
});

test('a missing End of Track is a warning, said once', () => {
  const file = readMidiFile(smf(1, 96, [track([ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0)], false), track([], false)]));
  assert.equal(file.warnings.filter((w) => /End of Track/.test(w)).length, 1);
  assert.equal(file.tracks[0].notes[0].length, 1);
});

test('bytes after End of Track and an unknown chunk are skipped', () => {
  const bytes = Uint8Array.from([...smf(0, 96, [track([ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0)])]), ...[0x58, 0x58, 0x58, 0x58, 0, 0, 0, 2, 7, 7]]);
  const file = readMidiFile(bytes);
  assert.equal(file.tracks.length, 1);
  assert.equal(file.tracks[0].notes.length, 1);
});

test('format 1: tempo and meter come from every track, merged in time order', () => {
  const file = readMidiFile(smf(1, 480, [
    track([tempoEv(0, 100)]),
    track([meterEv(0, 3, 2), tempoEv(1920, 150)]),     // 3/4 at 0, so bar 0 is 3/4; tempo at beat 4
    track([tempoEv(960, 75), meterEv(0, 6, 3)]),     // beat 2 for both; 6/8 at beat 2 is mid-bar of the 3-beat bar 0, so it moves to bar 1
  ]));
  assert.deepEqual(file.tempo, [{ beat: 0, bpm: 100 }, { beat: 2, bpm: 75 }, { beat: 4, bpm: 150 }]);
  assert.deepEqual(file.meter.map((m) => [m.bar, m.numerator]), [[0, 3], [1, 6]]);
});

test('a tempo first set after beat 0 gets 120 BPM before it', () => {
  const file = readMidiFile(smf(0, 96, [track([tempoEv(96, 60)])]));
  assert.deepEqual(file.tempo, [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]);
});

test('two tempos at one tick: the later wins', () => {
  assert.deepEqual(readMidiFile(smf(0, 96, [track([tempoEv(0, 100), tempoEv(0, 80)])])).tempo, [{ beat: 0, bpm: 80 }]);
});

test('a tempo outside TempoMap\'s range is clamped', () => {
  const us = 0xffffff;
  const file = readMidiFile(smf(0, 96, [track([ev(0, 0xff, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255)])]));
  assert.equal(file.tempo[0].bpm, 20);
});

test('format 2: every track from beat 0, with a warning', () => {
  const file = readMidiFile(smf(2, 96, [
    track([ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0)]),
    track([ev(0, 0x90, 64, 100), ev(192, 0x90, 64, 0)]),
  ]));
  assert.equal(file.format, 2);
  assert.deepEqual(file.tracks.map((t) => t.notes[0].start), [0, 0]);
  assert.ok(file.warnings.some((w) => /format 2/.test(w)));
});

test('SMPTE division: seconds to beats at the file\'s tempo, with a warning', () => {
  // −25 frames per second (0xe7), 40 ticks per frame: 1000 ticks per second
  const file = readMidiFile(smf(0, 0xe728, [track([tempoEv(0, 60), ev(2000, 0x90, 60, 100), ev(1000, 0x90, 60, 0)])]));
  assert.equal(file.ticksPerBeat, 1000);   // at 60 BPM a beat is a second
  assert.deepEqual(file.tracks[0].notes.map((n) => [n.start, n.length]), [[2, 1]]);
  assert.ok(file.warnings.some((w) => /SMPTE/.test(w)));
});

test('SMPTE division: tempo is the one the positions were converted at, so TempoMap agrees', () => {
  // 1000 ticks a second; 60 BPM first, then 240 BPM at 2 s. A note at 4 s must come back at 4 s.
  const file = readMidiFile(smf(0, 0xe728, [track([tempoEv(0, 60), tempoEv(2000, 240), ev(2000, 0x90, 60, 100), ev(1000, 0x90, 60, 0)])]));
  assert.deepEqual(file.tempo, [{ beat: 0, bpm: 60 }]);
  assert.ok(file.warnings.some((w) => /Set Tempo events after the first were dropped/.test(w)));
  const note = file.tracks[0].notes[0];
  const map = new TempoMap(file.tempo);
  assert.equal(map.secondsAt(note.start), 4);
  assert.equal(map.secondsAt(note.start + note.length), 5);
});

test('SMPTE division with no tempo reads at 120 BPM', () => {
  const file = readMidiFile(smf(0, 0xe728, [track([ev(1000, 0x90, 60, 100), ev(1000, 0x90, 60, 0)])]));
  assert.deepEqual(file.tracks[0].notes.map((n) => [n.start, n.length]), [[2, 2]]);
});

test('a time signature in the middle of a bar moves to the next bar line, with a warning', () => {
  const file = readMidiFile(smf(0, 480, [track([meterEv(960, 3, 2), meterEv(2880, 6, 3)])]));   // beat 2 of 4/4; then beat 6 = bar 1 + 2 beats of 3/4
  assert.deepEqual(file.meter, [
    { bar: 0, numerator: 4, denominator: 4 },
    { bar: 1, numerator: 3, denominator: 4 },
    { bar: 3, numerator: 6, denominator: 8 },
  ]);
  assert.equal(file.warnings.filter((w) => /middle of a bar/.test(w)).length, 1);
});

test('a time signature on a bar line stays there, and one at the start replaces 4/4', () => {
  const file = readMidiFile(smf(0, 480, [track([meterEv(0, 7, 3), meterEv(3360, 4, 2)])]));   // 7/8 is 3.5 beats: bar 2 = beat 7 = tick 3360
  assert.deepEqual(file.meter, [{ bar: 0, numerator: 7, denominator: 8 }, { bar: 2, numerator: 4, denominator: 4 }]);
  assert.deepEqual(file.warnings, []);
});

test('a division of ticks per beat is kept', () => {
  assert.equal(readMidiFile(smf(0, 960, [track([])])).ticksPerBeat, 960);
});
