// The reverb kernel: an FDN whose RT60 is the Decay setting within 10%,
// whose two outputs are decorrelated, and which renders the same twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reverb } from '../src/audio/dsp/devices/reverb.ts';
import { Section } from '../src/audio/dsp/devices/section.ts';
import { SR, correlation, noise, rms, run, set, silence } from './kernels.ts';

const impulseResponse = (decay: number, sr = SR, seconds = Math.max(1.5, 2 * decay)) => {
  const x = new Float32Array(Math.ceil(seconds * sr));
  x[0] = 1;
  return run(set(new Reverb(sr), { Decay: decay, 'Dry/Wet': 100 }), x, x);
};

// Schroeder's backward integration of the energy, and the slope between
// -10 and -40 dB taken out to -60 (a T30 estimate of RT60; it starts at
// -10 rather than -5 so the first echoes, two line lengths long, don't
// weigh on a 0.2 s decay)
const rt60 = (ir: Float32Array, sr: number) => {
  const edc = new Float64Array(ir.length);
  let sum = 0;
  for (let i = ir.length - 1; i >= 0; i--) { sum += ir[i] * ir[i]; edc[i] = sum; }
  const top = 10 * Math.log10(edc[0]);
  const at = (db: number) => edc.findIndex((e) => 10 * Math.log10(e) - top <= db);
  const a = at(-10), b = at(-40);
  return ((b - a) / sr) * (60 / 30);
};

// The mid band, 250 Hz to 2 kHz, where the damping takes nothing: Decay
// is the RT60 there, as a reverb's decay time is usually given (the
// highs decay faster, as in a room, so the broadband figure reads
// shorter: it is printed by the last test)
const midBand = (x: Float32Array, sr: number) => {
  const y = new Float32Array(x), z = new Float32Array(x);
  for (const [type, hz] of [['highpass', 250], ['highpass', 250], ['lowpass', 2000], ['lowpass', 2000]] as const) {
    const s = new Section(sr);
    s.set(type, hz, Math.SQRT1_2, 0);
    s.run(y, z, 0, y.length);
  }
  return y;
};

for (const decay of [0.2, 0.5, 1, 2.5, 5, 10]) {
  test(`RT60 at Decay ${decay} s is within 10%`, () => {
    const ir = impulseResponse(decay);
    const t = rt60(midBand(ir.l, SR), SR), tr = rt60(midBand(ir.r, SR), SR);
    assert.ok(Math.abs(t - decay) / decay < 0.1 && Math.abs(tr - decay) / decay < 0.1, `measured ${t.toFixed(3)} s left, ${tr.toFixed(3)} s right`);
  });
}

test('RT60 holds at 44.1 kHz', () => {
  const ir = impulseResponse(1.5, 44100);
  const t = rt60(midBand(ir.l, 44100), 44100);
  assert.ok(Math.abs(t - 1.5) / 1.5 < 0.1, `measured ${t.toFixed(3)} s`);
});

test('the highs decay faster than the mid band, and the broadband figure is reported', () => {
  const ir = impulseResponse(2.5);
  const mid = rt60(midBand(ir.l, SR), SR), broad = rt60(ir.l, SR);
  const high = (() => { const y = new Float32Array(ir.l), z = new Float32Array(ir.l); for (let i = 0; i < 2; i++) { const s = new Section(SR); s.set('highpass', 8000, Math.SQRT1_2, 0); s.run(y, z, 0, y.length); } return rt60(y, SR); })();
  console.log(`RT60 at Decay 2.5 s: mid band ${mid.toFixed(2)} s, above 8 kHz ${high.toFixed(2)} s, broadband ${broad.toFixed(2)} s`);
  assert.ok(high < mid && high > 0.3 * mid, `above 8 kHz: ${high.toFixed(2)} s`);
  assert.ok(broad > 0.75 * mid && broad <= mid * 1.05, `broadband: ${broad.toFixed(2)} s`);
});

test('left and right are decorrelated (coefficient below 0.3)', () => {
  const ir = impulseResponse(2);
  const c = correlation(ir.l, ir.r);
  assert.ok(Math.abs(c) < 0.3, `impulse responses correlate at ${c.toFixed(3)}`);
  const x = noise(2 * SR, 0.5, 41);
  const y = run(set(new Reverb(SR), { Decay: 2, 'Dry/Wet': 100 }), x, x);
  const cn = correlation(y.l.subarray(SR), y.r.subarray(SR));
  assert.ok(Math.abs(cn) < 0.3, `noise tails correlate at ${cn.toFixed(3)}`);
});

test('the wet level is in the native convolver\'s range: a steady input comes out within 6 dB of itself', () => {
  const x = noise(3 * SR, 0.25, 42);
  const y = run(set(new Reverb(SR), { Decay: 2.5, 'Dry/Wet': 100 }), x, x);
  const ratio = 20 * Math.log10(rms(y.l, 2 * SR) / rms(x, 2 * SR));
  assert.ok(Math.abs(ratio) < 6, `wet is ${ratio.toFixed(1)} dB against dry`);
});

test('Dry/Wet 0 is the input; the default mix is 30% wet', () => {
  const x = noise(SR, 0.5, 43);
  const dry = run(set(new Reverb(SR), { 'Dry/Wet': 0 }), x, x);
  assert.ok(dry.l.every((v, i) => v === x[i]));
  const mixed = run(new Reverb(SR), x, x);
  const wet = run(set(new Reverb(SR), { 'Dry/Wet': 100 }), x, x);
  for (let i = 100; i < SR; i += 977) assert.ok(Math.abs(mixed.l[i] - (0.7 * x[i] + 0.3 * wet.l[i])) < 1e-5);
});

test('the tail covers the decay, and after it the network is empty for real', () => {
  const k = set(new Reverb(SR), { Decay: 0.5, 'Dry/Wet': 100 });
  assert.ok(k.tail() >= 0.5 * SR && k.tail() <= 2 * SR);
  const x = new Float32Array(3 * SR);
  x[0] = 1;
  const y = run(k, x, silence(3 * SR));
  assert.ok(y.l.slice(2 * SR).every((v) => v === 0));
  // and it wakes up again
  const again = run(k, x, x);
  assert.ok(again.l.some((v) => v !== 0));
});
