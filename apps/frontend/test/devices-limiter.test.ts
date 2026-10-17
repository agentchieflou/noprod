// The limiter kernel: never over its ceiling in true peak on a worst-case
// program, measured by the LoudnessMeter that defines true peak here; its
// lookahead reported as latency; nothing touched below the ceiling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysis } from '@noprod/sound';
import { Limiter } from '../src/audio/dsp/devices/limiter.ts';
import { SR, concat, noise, run, set, silence, sine } from './kernels.ts';

const truePeakDb = (l: Float32Array, r: Float32Array, sr = SR) => {
  const m = new analysis.LoudnessMeter(sr);
  m.push(l, r);
  return m.truePeak;
};

// The worst case: a sine at a quarter of the sample rate whose samples
// sit at 0.707 of its peak (the peak falls between them), bursts of
// noise clipped hard at full scale (the reconstruction overshoots the
// corners), both well over any ceiling
const program = (sr = SR) => {
  const burst = sine(0.3 * sr, sr / 4, 1.2, sr, Math.PI / 4);
  const drums = noise(0.3 * sr, 3, 51).map((v) => Math.max(-1, Math.min(1, v)));
  const quiet = sine(0.2 * sr, 440, 0.05);
  return concat(silence(0.05 * sr), burst, quiet, drums, quiet, burst, silence(0.3 * sr));
};

for (const ceiling of [-0.3, -1, -3, -6, -12]) {
  test(`never over a ${ceiling} dB ceiling in true peak, on the worst-case program`, () => {
    const l = program(), r = program().map((v, i) => (i % 3 === 0 ? -v : v));
    const unlimited = truePeakDb(l, r);
    const y = run(set(new Limiter(SR), { Ceiling: ceiling }), l, r);
    const tp = truePeakDb(y.l, y.r);
    assert.ok(tp <= ceiling, `true peak ${tp.toFixed(4)} dBTP over a ${ceiling} dB ceiling (unlimited: ${unlimited.toFixed(2)} dBTP)`);
    assert.ok(tp > ceiling - 0.1, `and just under it: ${tp.toFixed(3)} dBTP`);
  });
}

test('at 44.1 kHz too, and with a short release', () => {
  const l = program(44100), r = program(44100);
  const y = run(set(new Limiter(44100), { Ceiling: -1, Release: 10 }), l, r);
  const tp = truePeakDb(y.l, y.r, 44100);
  assert.ok(tp <= -1 && tp > -1.1, `true peak ${tp.toFixed(4)} dBTP`);
});

test('a signal below the ceiling passes untouched, delayed by the reported latency', () => {
  const k = new Limiter(SR);
  const x = noise(SR, 0.3, 52);
  const y = run(k, x, x);
  assert.ok(k.latency > 0 && k.latency < 0.005 * SR, `latency ${k.latency} frames`);
  for (let i = k.latency; i < SR; i++) assert.equal(y.l[i], x[i - k.latency]);
  assert.ok(y.l.subarray(0, k.latency).every((v) => v === 0));
  assert.equal(k.reduction(), 0);
});

test('the gain is down before a transient arrives, and recovers over Release', () => {
  const x = concat(silence(0.2 * SR), new Float32Array(0.02 * SR).fill(1), silence(0.8 * SR));
  const k = set(new Limiter(SR), { Ceiling: -6, Release: 100 });
  const y = run(k, x, x);
  const ceiling = Math.pow(10, -6 / 20);
  const onset = 0.2 * SR + k.latency;
  assert.ok(y.l.subarray(onset, onset + 0.02 * SR).every((v) => v <= ceiling + 1e-6), 'held at the ceiling through the burst');
  // a step's corners overshoot between samples, so the burst sits a little under the ceiling
  assert.ok(y.l[onset + 100] > ceiling * 0.85, `near the ceiling: ${y.l[onset + 100]}`);
  // the reduction after the burst recovers with the release's time constant
  const reduction = (atFrame: number) => {
    const k2 = set(new Limiter(SR), { Ceiling: -6, Release: 100 });
    run(k2, x.subarray(0, atFrame), x.subarray(0, atFrame));
    return k2.reduction();
  };
  const end = 0.22 * SR + k.latency;
  const r0 = reduction(end), r1 = reduction(end + 0.1 * SR), r2 = reduction(end + 0.5 * SR);
  assert.ok(r0 < -5.9 && r1 > r0 && r1 < -1 && r2 > -0.1, `reduction ${r0.toFixed(2)}, ${r1.toFixed(2)}, ${r2.toFixed(2)} dB`);
});

test('a Ceiling lane ramps, a Ceiling knob glides', () => {
  const margin = Math.pow(10, -0.05 / 20);     // the kernel aims this far under the ceiling
  const x = new Float32Array(SR).fill(0.9);
  const k = set(new Limiter(SR), { Ceiling: -1 });
  const y = run(k, x, x, [128], (b) => (b === 200 ? new Map([['Ceiling', [-1, -12]]]) : undefined));
  const after = 200 * 128 + 128 + k.latency + 0.01 * SR;
  assert.ok(Math.abs(y.l[after] - Math.pow(10, -12 / 20) * margin) < 1e-4, `after the ramp: ${y.l[after]}`);
  k.set('Ceiling', -1, 0);
  const more = run(k, x, x);
  assert.ok(more.l[0] < 0.3 && Math.abs(more.l[SR - 1] - Math.pow(10, -1 / 20) * margin) < 1e-4, 'glides back up');
});
