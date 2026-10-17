// Its own file: the memory check reads this process's peak, which an earlier test's peak would hide
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, MAX_FILE_BYTES } from '../src/index.ts';
import { smf, track, ev } from './helpers.ts';

test('a 64 MB file of empty unknown chunks is skipped as it is walked: fast, and no memory per chunk', () => {
  const base = smf(0, 96, [track([ev(0, 0x90, 60, 100), ev(96, 0x90, 60, 0)])]);
  const bytes = new Uint8Array(MAX_FILE_BYTES);
  bytes.set(base);
  for (let p = base.length; p + 8 <= bytes.length; p += 8) bytes.set([0x4a, 0x55, 0x4e, 0x4b], p);   // "JUNK", length 0
  const peakBefore = process.resourceUsage().maxRSS;   // KB
  const started = performance.now();
  const file = readMidiFile(bytes);
  const took = performance.now() - started;
  const grew = (process.resourceUsage().maxRSS - peakBefore) / 1024;   // MB
  assert.equal(file.tracks[0].notes.length, 1);
  assert.ok(took < 2000, `${took.toFixed(0)} ms`);
  assert.ok(grew < 100, `peak memory grew ${grew.toFixed(0)} MB`);
});
