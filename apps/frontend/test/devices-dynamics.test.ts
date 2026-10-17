// The Compressor and Glue kernels against the dynamics worklet they port:
// the same program through the worklet's loop (here as plain code) and
// through the kernel is the same to 1e-6, and the reduction at a known
// level is what the ratio and knee say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compressor, Glue } from '../src/audio/dsp/devices/index.ts';
import { SR, concat, maxAbsDiff, noise, run, set, silence, sine } from './kernels.ts';

// worklets/dynamics-processor.js's process(), with its AudioParams as a
// plain record (threshold dB, ratio, attack s, release s, knee dB, makeup
// dB, range dB, mix 0..1, softClip)
interface Params { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number; range: number; mix: number; softClip: boolean }
const reference = (p: Params, inL: Float32Array, inR: Float32Array) => {
  const sr = SR;
  const outL = new Float32Array(inL.length), outR = new Float32Array(inR.length);
  let env = 0, slowEnv = 0;
  const ratio = Math.max(1, p.ratio);
  const makeup = Math.pow(10, p.makeup / 20);
  const attCoef = Math.exp(-1 / (Math.max(0.00001, p.attack) * sr));
  const slope = 1 / ratio - 1;
  const slowCoef = Math.exp(-1 / (2 * sr));
  for (let i = 0; i < inL.length; i++) {
    const l = inL[i], r = inR[i];
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const xDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
    const over = xDb - p.threshold;
    let target = 0;
    if (p.knee > 0 && 2 * Math.abs(over) <= p.knee) target = (slope * (over + p.knee / 2) * (over + p.knee / 2)) / (2 * p.knee);
    else if (over > 0) target = slope * over;
    if (target < -p.range) target = -p.range;
    let relCoef;
    if (p.release > 0) relCoef = Math.exp(-1 / (p.release * sr));
    else {
      const sustained = Math.min(1, -slowEnv / 6);
      relCoef = Math.exp(-1 / ((0.08 + 1.1 * sustained) * sr));
    }
    const coef = target < env ? attCoef : relCoef;
    env = coef * env + (1 - coef) * target;
    slowEnv = slowCoef * slowEnv + (1 - slowCoef) * env;
    const g = Math.pow(10, env / 20) * makeup;
    let yl = l * (1 - p.mix) + l * g * p.mix, yr = r * (1 - p.mix) + r * g * p.mix;
    if (p.softClip) { yl = Math.tanh(yl); yr = Math.tanh(yr); }
    outL[i] = yl; outR[i] = yr;
  }
  return { l: outL, r: outR };
};

// A program with transients, a held tone and silence: drum-like bursts of
// noise over a sine, then nothing
const programL = concat(noise(0.1 * SR, 0.9, 21), sine(0.4 * SR, 220, 0.3), noise(0.05 * SR, 1.0, 22), sine(0.6 * SR, 110, 0.6), silence(0.3 * SR));
const programR = concat(noise(0.1 * SR, 0.8, 23), sine(0.4 * SR, 330, 0.3, SR, 1), noise(0.05 * SR, 0.9, 24), sine(0.6 * SR, 110, 0.5, SR, 0.5), silence(0.3 * SR));

const compressorCases: [string, Record<string, number>, Params][] = [
  ['defaults', {}, { threshold: -18, ratio: 4, attack: 0.01, release: 0.1, knee: 6, makeup: 0, range: 100, mix: 1, softClip: false }],
  ['hard knee, fast, 20:1, makeup', { Threshold: -24, Ratio: 20, Attack: 0.5, Release: 30, Knee: 0, Makeup: 6 }, { threshold: -24, ratio: 20, attack: 0.0005, release: 0.03, knee: 0, makeup: 6, range: 100, mix: 1, softClip: false }],
  ['half wet, wide knee', { Threshold: -12, Ratio: 2, Attack: 50, Release: 400, Knee: 30, 'Dry/Wet': 50 }, { threshold: -12, ratio: 2, attack: 0.05, release: 0.4, knee: 30, makeup: 0, range: 100, mix: 0.5, softClip: false }]
];
for (const [name, params, p] of compressorCases) {
  test(`Compressor matches the worklet to 1e-6: ${name}`, () => {
    const want = reference(p, programL, programR);
    const got = run(set(new Compressor(SR), params), programL, programR);
    const diff = Math.max(maxAbsDiff(want.l, got.l), maxAbsDiff(want.r, got.r));
    assert.ok(diff < 1e-6, `differs by ${diff}`);
  });
}

const glueCases: [string, Record<string, number | string | boolean>, Params][] = [
  ['defaults (Auto release, Classic knee)', {}, { threshold: -10, ratio: 4, attack: 0.01, release: 0, knee: 0, makeup: 0, range: 70, mix: 1, softClip: false }],
  ['10:1, 0.1 ms, 0.4 s, soft knee, soft clip, range 6', { Threshold: -20, Ratio: '10:1', Attack: '0.1 ms', Release: '0.4 s', Knee: 'Soft', 'Soft Clip': true, Range: 6, Makeup: 8 }, { threshold: -20, ratio: 10, attack: 0.0001, release: 0.4, knee: 10, makeup: 8, range: 6, mix: 1, softClip: true }],
  ['2:1, 30 ms, 1.2 s, half wet', { Threshold: -30, Ratio: '2:1', Attack: '30 ms', Release: '1.2 s', 'Dry/Wet': 50 }, { threshold: -30, ratio: 2, attack: 0.03, release: 1.2, knee: 0, makeup: 0, range: 70, mix: 0.5, softClip: false }]
];
for (const [name, params, p] of glueCases) {
  test(`Glue matches the worklet to 1e-6: ${name}`, () => {
    const want = reference(p, programL, programR);
    const got = run(set(new Glue(SR), params), programL, programR);
    const diff = Math.max(maxAbsDiff(want.l, got.l), maxAbsDiff(want.r, got.r));
    assert.ok(diff < 1e-6, `differs by ${diff}`);
  });
}

// A constant level at `peakDb` for a second; the reduction it settles to
// (a sine would ripple: the detector reads each sample's peak, and the
// release lets go a little between a sine's peaks, as the worklet does)
const settled = (kernel: Compressor | Glue, peakDb: number) => {
  const x = new Float32Array(SR).fill(Math.pow(10, peakDb / 20));
  run(kernel, x, x);
  return kernel.reduction();
};

test('the reduction at a known level follows the ratio, the knee and the range', () => {
  const near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) < 0.05, `${what}: ${got.toFixed(3)} dB, wanted ${want}`);
  // 12 dB over a -18 dB threshold at 4:1: 12 * (1/4 - 1) = -9 dB
  near(settled(set(new Compressor(SR), { Knee: 0 }), -6), -9, '12 dB over at 4:1');
  // 3 dB over, inside a 6 dB knee: (1/4 - 1) * (3 + 3)^2 / (2 * 6) = -2.25 dB
  near(settled(set(new Compressor(SR), { Threshold: -9, Knee: 6 }), -6), -2.25, '3 dB into a 6 dB knee');
  // below the threshold: nothing
  near(settled(new Compressor(SR), -30), 0, 'below the threshold');
  // Glue at 10:1, 10 dB over: -9 dB; its Range caps it
  near(settled(set(new Glue(SR), { Threshold: -16, Ratio: '10:1' }), -6), -9, 'Glue, 10 dB over at 10:1');
  near(settled(set(new Glue(SR), { Threshold: -16, Ratio: '10:1', Range: 3 }), -6), -3, 'Glue with a 3 dB range');
});

test('makeup lifts a quiet signal by its dB, and Dry/Wet 0 is the input', () => {
  const x = sine(SR, 440, 0.01);
  const lifted = run(set(new Compressor(SR), { Makeup: 6 }), x, x);
  const want = Math.pow(10, 6 / 20);
  for (let i = 1000; i < SR; i += 997) assert.ok(Math.abs(lifted.l[i] - x[i] * want) < 1e-6);
  const dry = run(set(new Compressor(SR), { 'Dry/Wet': 0, Threshold: -60 }), x, x);
  assert.ok(maxAbsDiff(dry.l, x) < 1e-7);
});

test('a makeup knob glides, and a Threshold lane ramps within the block', () => {
  const x = new Float32Array(SR).fill(0.01);
  const c = new Compressor(SR);
  const bl = new Float32Array(128), br = new Float32Array(128), ol = new Float32Array(128), or = new Float32Array(128);
  const y = new Float32Array(SR);
  const half = 188 * 128;      // a block boundary near the middle
  for (let at = 0; at < SR; at += 128) {
    if (at === half) c.set('Makeup', 12, at);
    bl.set(x.subarray(at, at + 128)); br.set(bl);
    c.process(bl, br, ol, or, 128);
    y.set(ol, at);
  }
  const lifted = 0.01 * Math.pow(10, 12 / 20);
  assert.ok(y[half - 1] === x[0] && y[half] < 0.011 && y[half + 240] > 0.02 && y[half + 240] < 0.03 && Math.abs(y[half + 2400] - lifted) < 1e-5,
    `the makeup glides from 0 to +12 dB: ${y[half - 1]}, ${y[half]}, ${y[half + 240]}, ${y[half + 2400]}`);
  // A ramp of the threshold over a block of silence then tone: the
  // reduction at the end of the block reflects the ramp's end value
  const loud = new Float32Array(128).fill(0.5);
  const a = new Compressor(SR), b = new Compressor(SR);
  set(a, { Knee: 0, Attack: 0.1, Release: 10 }); set(b, { Knee: 0, Attack: 0.1, Release: 10, Threshold: -40 });
  const ramped = new Float32Array(128), fixed = new Float32Array(128);
  for (let i = 0; i < 40; i++) {
    a.process(loud, loud, ramped, ramped, 128, new Map([['Threshold', [-40, -40]]]));
    b.process(loud, loud, fixed, fixed, 128);
  }
  assert.ok(maxAbsDiff(ramped, fixed) < 1e-6, 'a flat ramp is the same as the setting');
  assert.ok(Math.abs(a.reduction() - b.reduction()) < 1e-9);
});
