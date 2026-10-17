import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile } from '../src/index.ts';
import { TempoMap } from '../../time/src/index.ts';
import { smf, track, ev, tempoEv } from './helpers.ts';

// Seconds the way a player of the file would count them: ticks times the
// microseconds per quarter in force, divided by the division
function secondsOfTicks(division: number, tempos: [number, number][], tick: number) {
  let seconds = 0, at = 0, us = 500000;
  for (const [t, u] of tempos) {
    if (t >= tick) break;
    seconds += ((t - at) * us) / division / 1e6;
    at = t; us = u;
  }
  return seconds + ((tick - at) * us) / division / 1e6;
}

test('a TempoMap built from `tempo` agrees with the file\'s own tick arithmetic', () => {
  const division = 480;
  const changes: [number, number][] = [[0, 100], [1920, 150], [4000, 75], [9600, 200]].map(([t, bpm]) => [t, Math.round(60e6 / bpm)]);
  const file = readMidiFile(smf(1, division, [
    track(changes.map(([t, us], i) => tempoEv(i ? t - changes[i - 1][0] : t, 60e6 / us))),
    track([ev(5000, 0x90, 60, 100), ev(5000, 0x90, 60, 0), ev(0, 0x90, 62, 100), ev(1234, 0x90, 62, 0)]),
  ]));
  const map = new TempoMap(file.tempo);
  assert.equal(map.events.length, 4);
  for (const note of file.tracks[1].notes) {
    for (const beat of [note.start, note.start + note.length]) {
      const expected = secondsOfTicks(division, changes, Math.round(beat * division));
      assert.ok(Math.abs(map.secondsAt(beat) - expected) < 1e-9, `${beat}: ${map.secondsAt(beat)} vs ${expected}`);
    }
  }
});
