// The panner kernel against StereoPannerNode's equal-power law as the Web
// Audio spec states it for a stereo input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Panner } from '../src/audio/dsp/devices/index.ts';
import { SR, maxAbsDiff, noise, run, set } from './kernels.ts';

// The spec's law for one sample
const law = (pan: number, l: number, r: number): [number, number] => {
  const x = pan <= 0 ? pan + 1 : pan;
  const gl = Math.cos((x * Math.PI) / 2), gr = Math.sin((x * Math.PI) / 2);
  return pan <= 0 ? [l + r * gl, r * gr] : [l * gl, r + l * gr];
};

test('each pan position matches the spec to 1e-6 (0.01 dB is 1.2e-3)', () => {
  const l = noise(4096, 0.5, 31), r = noise(4096, 0.5, 32);
  for (const pan of [-1, -0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const y = run(set(new Panner(SR), { Pan: pan }), l, r);
    const wl = Float32Array.from(l, (v, i) => law(pan, v, r[i])[0]), wr = Float32Array.from(l, (v, i) => law(pan, v, r[i])[1]);
    assert.ok(maxAbsDiff(y.l, wl) < 1e-6 && maxAbsDiff(y.r, wr) < 1e-6, `pan ${pan}`);
  }
});

test('centre is unity, hard left folds the right channel into the left, hard right the other way', () => {
  const l = noise(1024, 0.5, 33), r = noise(1024, 0.5, 34);
  const c = run(new Panner(SR), l, r);
  assert.ok(maxAbsDiff(c.l, l) === 0 && maxAbsDiff(c.r, r) === 0);
  const left = run(set(new Panner(SR), { Pan: -1 }), l, r);
  assert.ok(maxAbsDiff(left.l, Float32Array.from(l, (v, i) => v + r[i])) < 1e-6 && left.r.every((v) => Math.abs(v) < 1e-7));
  const right = run(set(new Panner(SR), { Pan: 1 }), l, r);
  // cos(pi/2) is 6e-17, not 0, here as in the native node
  assert.ok(maxAbsDiff(right.r, Float32Array.from(r, (v, i) => v + l[i])) < 1e-6 && right.l.every((v) => Math.abs(v) < 1e-7));
});

test('a Pan lane ramps within the block, and a knob glides', () => {
  const l = new Float32Array(128).fill(0.5), r = new Float32Array(128);
  const y = run(new Panner(SR), l, r, [128], () => new Map([['Pan', [-1, 1]]]));
  for (let i = 0; i < 128; i++) {
    const pan = -1 + (2 / 127) * i;
    const [wl, wr] = law(pan, 0.5, 0);
    assert.ok(Math.abs(y.l[i] - wl) < 1e-6 && Math.abs(y.r[i] - wr) < 1e-6, `sample ${i}`);
  }
  const p = new Panner(SR);
  const ol = new Float32Array(128), or = new Float32Array(128);
  p.process(l, r, ol, or, 128);
  p.set('Pan', 1, 128);
  p.process(l, r, ol, or, 128);
  assert.ok(ol[0] > 0.49 && ol[127] < 0.4 && ol[127] > 0.1, `the pan glides: ${ol[0]} .. ${ol[127]}`);
  for (let i = 0; i < 40; i++) p.process(l, r, ol, or, 128);
  assert.ok(Math.abs(ol[127]) < 1e-7 && Math.abs(or[127] - 0.5) < 1e-6, 'and arrives');
});
