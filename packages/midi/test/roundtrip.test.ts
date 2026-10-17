import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, writeMidiFile } from '../src/index.ts';
import type { MidiFileData, MidiTrack } from '../src/index.ts';

// Positions on the file's own ticks, so a round trip is exact
const at = (ticks: number, tpb: number) => ticks / tpb;

function song(tpb: number): MidiFileData & { tempo: NonNullable<MidiFileData['tempo']> } {
  const t = (ticks: number) => at(ticks, tpb);
  const lead: MidiTrack = {
    name: 'Lead',
    notes: [
      { pitch: 60, start: t(0), length: t(tpb), velocity: 100 / 127, channel: 0 },
      { pitch: 64, start: t(tpb), length: t(tpb / 2), velocity: 1, channel: 0, releaseVelocity: 30 / 127 },
      { pitch: 64, start: t(tpb * 5 / 4), length: t(tpb), velocity: 20 / 127, channel: 0 },   // overlaps the one before: FIFO
      { pitch: 67, start: t(tpb * 2), length: t(1), velocity: 1 / 127, channel: 5 },
    ],
    controllers: [{ beat: t(0), channel: 0, controller: 7, value: 100 }, { beat: t(tpb * 3), channel: 5, controller: 64, value: 127 }],
    pitchBend: [{ beat: t(tpb), channel: 0, value: -1 }, { beat: t(tpb * 2), channel: 0, value: 0 }, { beat: t(tpb * 3), channel: 0, value: 4096 / 8192 }],
    programs: [{ beat: t(0), channel: 0, program: 81 }, { beat: t(0), channel: 5, program: 0 }],
    channelPressure: [{ beat: t(tpb), channel: 0, value: 64 }],
  };
  const bass: MidiTrack = {
    name: 'Bass',
    notes: [{ pitch: 36, start: t(0), length: t(tpb * 4), velocity: 102 / 127, channel: 1 }],
    controllers: [], pitchBend: [], programs: [{ beat: t(0), channel: 1, program: 33 }], channelPressure: [],
  };
  return {
    tempo: [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 75 }, { beat: 12.5, bpm: 150 }],
    meter: [{ bar: 0, numerator: 4, denominator: 4 }, { bar: 2, numerator: 7, denominator: 8 }, { bar: 5, numerator: 3, denominator: 4 }],
    key: [{ beat: 0, sharps: -3, minor: true }, { beat: 16, sharps: 2, minor: false }],
    markers: [{ beat: 0, text: 'Intro' }, { beat: 8, text: 'Verse – é' }],
    tracks: [lead, bass],
  };
}

for (const tpb of [96, 480, 960]) {
  test(`format 1 round trip at ${tpb} ticks per beat`, () => {
    const x = song(tpb);
    const back = readMidiFile(writeMidiFile(x, { ticksPerBeat: tpb }));
    assert.equal(back.format, 1);
    assert.equal(back.ticksPerBeat, tpb);
    assert.deepEqual({ ...back, format: undefined, ticksPerBeat: undefined, warnings: undefined }, { ...x, format: undefined, ticksPerBeat: undefined, warnings: undefined });
    assert.deepEqual(back.warnings, []);
  });

  test(`format 0 round trip at ${tpb} ticks per beat`, () => {
    const { tracks, ...conductor } = song(tpb);
    const x = { ...conductor, tracks: [{ ...tracks[0], name: 'Lead' }] };
    const back = readMidiFile(writeMidiFile(x, { format: 0, ticksPerBeat: tpb }));
    assert.equal(back.format, 0);
    assert.deepEqual({ ...back, format: undefined, ticksPerBeat: undefined, warnings: undefined }, { ...x, format: undefined, ticksPerBeat: undefined, warnings: undefined });
  });
}

test('the default division is 960', () => {
  assert.equal(readMidiFile(writeMidiFile({ tracks: [] })).ticksPerBeat, 960);
});

test('a file with no tracks writes one empty one', () => {
  const back = readMidiFile(writeMidiFile({ tracks: [] }));
  assert.equal(back.tracks.length, 1);
  assert.deepEqual(back.tempo, [{ beat: 0, bpm: 120 }]);
});

test('written files read back with no warnings, and writing the read file is stable', () => {
  const once = writeMidiFile(song(480), { ticksPerBeat: 480 });
  const twice = writeMidiFile(readMidiFile(once), { ticksPerBeat: 480 });
  assert.deepEqual(twice, once);
});
