// EQ Three and EQ Eight as kernels: each band type does what its name
// says, a sine through the kernel lands where response() says it will, an
// output ramp is exact to the sample, a knob glides, and nothing is lost on
// the way through an EQ with every band off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EqThree, EqEight } from '../src/audio/dsp/devices/index.ts';
import { SR, identical, magnitudeAt, maxAbsDiff, noise, run, set, sine } from './kernels.ts';

const FREQS = Float32Array.from({ length: 200 }, (_, i) => 20 * Math.pow(1000, i / 199));

// The level of a steady `hz` sine after a second through the kernel, in dB
// relative to the input (a whole number of cycles, read over the last half)
const through = (kernel: EqThree | EqEight, hz: number) => {
  const cycles = Math.max(1, Math.round((0.5 * hz) / 1));
  const n = Math.round((cycles * SR) / hz);
  const x = sine(SR + n, hz, 0.5);
  const y = run(kernel, x, x);
  return magnitudeAt(y.l, hz, SR, SR, SR + n) - magnitudeAt(x, hz, SR, SR, SR + n);
};

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} vs ${b.toFixed(3)} (±${tol})`);

test('EQ Three sums flat with every gain at 0 dB', () => {
  const eq = new EqThree(SR);
  const r = eq.response(FREQS);
  for (let i = 0; i < FREQS.length; i++) near(r[i], 0, 0.05, `response at ${FREQS[i].toFixed(0)} Hz`);
  for (const hz of [50, 250, 1000, 2500, 10000]) near(through(new EqThree(SR), hz), 0, 0.05, `${hz} Hz through`);
});

test('EQ Three: each band lifts, cuts and kills its own range', () => {
  near(through(set(new EqThree(SR), { GainLo: 6 }), 50), 6, 0.2, 'low +6');
  near(through(set(new EqThree(SR), { GainHi: -6 }), 12000), -6, 0.2, 'high -6');
  near(through(set(new EqThree(SR), { GainMid: 3 }), 1000), 3, 0.2, 'mid +3');
  assert.ok(through(set(new EqThree(SR), { 'Kill Lo': true }), 50) < -25, 'the low band killed');
  assert.ok(through(set(new EqThree(SR), { GainMid: -48 }), 1000) < -25, 'the mid band at -inf');
  // the crossovers move
  near(through(set(new EqThree(SR), { GainLo: 6, FreqLo: 2000 }), 1000), 6, 0.3, 'low +6 with the crossover at 2 kHz');
});

test('EQ Three: a sine lands where response() says', () => {
  const eq = set(new EqThree(SR), { GainLo: -9, GainMid: 4, GainHi: -3, FreqLo: 180, FreqHi: 4000 });
  for (const hz of [60, 180, 500, 1500, 4000, 9000]) {
    const r = eq.response(Float32Array.of(hz))[0];
    eq.reset();
    near(through(eq, hz), r, 0.1, `${hz} Hz`);
  }
});

test('EQ Eight with every band off and Output at 0 dB passes audio through untouched', () => {
  const eq = new EqEight(SR);
  for (let i = 1; i <= 8; i++) eq.set(`${i} On`, false, 0);
  const x = noise(SR, 0.5, 3);
  const y = run(eq, x, x);
  assert.ok(identical(x, y.l) && identical(x, y.r));
  assert.ok(eq.response(FREQS).every((v) => v === 0));
});

test('EQ Eight: the default state is flat', () => {
  const eq = new EqEight(SR);
  for (let i = 0; i < FREQS.length; i++) near(eq.response(FREQS)[i], 0, 1e-4, `response at ${FREQS[i].toFixed(0)} Hz`);
  for (const hz of [50, 1000, 12000]) near(through(new EqEight(SR), hz), 0, 1e-3, `${hz} Hz through`);
});

// A band set up alone on a fresh EQ Eight, every other band off
const band = (type: string, freq: number, gain = 0, q = 0.71) => {
  const eq = new EqEight(SR);
  for (let i = 1; i <= 8; i++) eq.set(`${i} On`, false, 0);
  return set(eq, { '4 On': true, '4 Type': type, '4 Freq': freq, '4 Gain': gain, '4 Q': q });
};

test('EQ Eight: each band type shapes the spectrum as its name says', () => {
  near(through(band('Bell', 1000, 6, 1), 1000), 6, 0.05, 'a bell at its centre');
  near(through(band('Bell', 1000, 6, 1), 100), 0, 0.1, 'a bell far below its centre');
  near(through(band('Low Shelf', 100, 6), 20), 6, 0.1, 'a low shelf below its corner');
  near(through(band('Low Shelf', 100, 6), 5000), 0, 0.05, 'a low shelf far above its corner');
  near(through(band('High Shelf', 6000, -6), 18000), -6, 0.3, 'a high shelf above its corner');
  near(through(band('High Shelf', 6000, -6), 200), 0, 0.05, 'a high shelf far below its corner');
  assert.ok(through(band('Notch', 1000, 0, 5), 1000) < -40, 'a notch at its centre');
  near(through(band('Notch', 1000, 0, 5), 1500), 0, 1, 'a notch half an octave up');
  near(through(band('Low Cut 12', 200), 200), -3, 0.1, 'a 12 dB low cut at its corner');
  near(through(band('Low Cut 12', 200), 50), -24.1, 0.5, 'a 12 dB low cut two octaves down');
  near(through(band('High Cut 12', 2000), 2000), -3, 0.1, 'a 12 dB high cut at its corner');
  near(through(band('High Cut 12', 2000), 8000), -25.7, 0.5, 'a 12 dB high cut two octaves up (-24.1 in the analog prototype; the bilinear warp steepens it this close to Nyquist)');
  near(through(band('Low Cut 48', 200), 100), -48.2, 1, 'a 48 dB low cut an octave down');
  near(through(band('Low Cut 48', 200), 2000), 0, 0.05, 'a 48 dB low cut far above its corner');
  near(through(band('High Cut 48', 2000), 4000), -48.2, 2, 'a 48 dB high cut an octave up');
});

test('EQ Eight: a sine lands where response() says, on a full preset', () => {
  const eq = set(new EqEight(SR), {
    '1 On': true, '1 Type': 'Low Cut 48', '1 Freq': 60,
    '2 Gain': -4, '3 Freq': 300, '3 Gain': 5, '3 Q': 2, '5 Gain': -6, '5 Q': 0.5, '6 Type': 'Notch', '6 Freq': 3000, '6 Q': 4,
    '7 Gain': 3, '8 On': true, '8 Type': 'High Cut 12', '8 Freq': 12000, Output: -2
  });
  for (const hz of [40, 80, 300, 1000, 2500, 3300, 6000, 12000, 16000]) {
    const r = eq.response(Float32Array.of(hz))[0];
    eq.reset();
    near(through(eq, hz), r, 0.1, `${hz} Hz`);
  }
});

test('EQ Eight: an Output ramp is exact to the sample', () => {
  const eq = new EqEight(SR);
  for (let i = 1; i <= 8; i++) eq.set(`${i} On`, false, 0);
  const x = noise(128, 0.5, 4);
  const y = run(eq, x, x, [128], () => new Map([['Output', [-12, 6]]]));
  const from = Math.pow(10, -12 / 20), to = Math.pow(10, 6 / 20);
  const want = Float32Array.from(x, (v, i) => v * (from + ((to - from) / 127) * i));
  assert.ok(maxAbsDiff(y.l, want) < 1e-6);
  // and the parameter stays where the ramp left it
  const after = run(eq, x, x);
  assert.ok(maxAbsDiff(after.l, Float32Array.from(x, (v) => v * to)) < 1e-6);
});

test('a knob glides: a gain set mid-stream reaches its value over milliseconds, not in a step', () => {
  const eq = new EqEight(SR);
  for (let i = 1; i <= 8; i++) eq.set(`${i} On`, false, 0);
  const x = new Float32Array(SR).fill(0.5);
  const half = 188 * 128;      // a block boundary near the middle
  const y = new Float32Array(SR);
  const bl = new Float32Array(128), br = new Float32Array(128), ol = new Float32Array(128), or = new Float32Array(128);
  for (let at = 0; at < SR; at += 128) {
    if (at === half) eq.set('Output', -12, at);
    bl.set(x.subarray(at, at + 128)); br.set(bl);
    eq.process(bl, br, ol, or, 128);
    y.set(ol, at);
  }
  const target = 0.5 * Math.pow(10, -12 / 20);
  assert.ok(y[half - 1] === 0.5, 'unchanged before');
  assert.ok(y[half] > 0.45, `the first sample after the knob moved is ${y[half]}, not a step`);
  assert.ok(Math.abs(y[half + Math.round(0.005 * SR)] - target) / (0.5 - target) < 0.45, 'most of the way after 5 ms');
  assert.ok(Math.abs(y[half + Math.round(0.1 * SR)] - target) < 1e-6, 'there after 100 ms');
  let maxStep = 0;
  for (let i = 1; i < SR; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
  assert.ok(maxStep < 0.002, `the largest sample-to-sample step is ${maxStep}`);
});
