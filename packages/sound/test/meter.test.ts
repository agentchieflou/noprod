import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysis } from '../src/index.ts';

const sr = 48000;
const sine = (hz: number, amp: number, seconds: number, phase = 0) =>
  Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * (i / sr) + phase));
const feed = (m: analysis.LoudnessMeter, l: Float32Array, r = l) => {
  for (let i = 0; i < l.length; i += 480) m.push(l.subarray(i, i + 480), r.subarray(i, i + 480)); // 10 ms blocks
};

test('a 997 Hz sine at -20 dBFS in both channels reads -20 LUFS', () => {
  const m = new analysis.LoudnessMeter(sr);
  feed(m, sine(997, 0.1, 5));
  assert.ok(Math.abs(m.momentary + 20) < 0.1, `momentary ${m.momentary}`);
  assert.ok(Math.abs(m.shortTerm + 20) < 0.1, `short-term ${m.shortTerm}`);
  assert.ok(Math.abs(m.integrated + 20) < 0.1, `integrated ${m.integrated}`);
});

test('the streaming meter agrees with the offline loudness', () => {
  const x = sine(440, 0.3, 2);
  const m = new analysis.LoudnessMeter(sr);
  feed(m, x);
  const offline = analysis.loudness(x, x, sr, 0.4);
  assert.ok(Math.abs(m.momentary - offline) < 0.2, `${m.momentary} vs ${offline}`);
});

test('integrated loudness gates out silence and reset starts over', () => {
  const m = new analysis.LoudnessMeter(sr);
  feed(m, sine(997, 0.1, 3));
  feed(m, new Float32Array(sr * 3));
  // blocks straddling the end of the sine still count; ungated, 3 s of silence would read -23
  assert.ok(Math.abs(m.integrated + 20) < 0.5, `integrated ${m.integrated}`);
  m.reset();
  assert.equal(m.integrated, -Infinity);
  assert.equal(m.truePeak, analysis.toDb(0));
});

test('true peak finds a peak between samples', () => {
  // fs/4 at 45 degrees: every sample is +-0.707 but the waveform reaches 1.0
  const x = sine(sr / 4, 1, 1, Math.PI / 4);
  assert.ok(analysis.peak(x) < 0.71);
  const m = new analysis.LoudnessMeter(sr);
  feed(m, x);
  assert.ok(m.truePeak > -0.3 && m.truePeak < 0.3, `${m.truePeak} dBTP`);
});
