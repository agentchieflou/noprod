// The delay kernel: exact to the sample, feedback that decays as the
// gain says, a knob that crossfades and a lane that bends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Delay } from '../src/audio/dsp/devices/delay.ts';
import { SR, run, set, silence, sine } from './kernels.ts';

const impulse = (frames: number) => { const x = new Float32Array(frames); x[0] = 1; return x; };

test('an impulse comes back exactly Time × sampleRate frames later, and repeats at the feedback gain', () => {
  const x = impulse(3 * SR);
  const y = run(set(new Delay(SR), { Time: 0.25, Feedback: 50, 'Dry/Wet': 100 }), x, x);
  const period = 0.25 * SR;
  for (let i = 0; i < y.l.length; i++) {
    const want = i > 0 && i % period === 0 ? Math.pow(0.5, i / period - 1) : 0;
    if (want > 0) assert.equal(y.l[i], want, `repeat at frame ${i}`);
    else assert.equal(y.l[i], 0, `nothing at frame ${i}`);
  }
});

test('any whole number of frames is exact, at 44.1 kHz too', () => {
  for (const [sr, time] of [[SR, 0.01], [SR, 1.9995], [44100, 0.1], [44100, 0.5]] as const) {
    const x = impulse(Math.ceil(time * sr) + 1000);
    const y = run(set(new Delay(sr), { Time: time, Feedback: 0, 'Dry/Wet': 100 }), x, x);
    const at = Math.round(time * sr);
    assert.ok(Math.abs(time * sr - at) < 1e-6, `${time} s at ${sr} Hz is whole`);
    assert.equal(y.l[at], 1, `${time} s at ${sr}: the impulse at frame ${at}`);
    assert.equal(y.l.reduce((s, v) => s + Math.abs(v), 0), 1, 'and nowhere else');
  }
});

test('a fractional delay is read between two samples, as DelayNode reads it', () => {
  const time = 0.3333, sr = 44100;          // 14698.53 frames
  const x = impulse(16000);
  const y = run(set(new Delay(sr), { Time: time, Feedback: 0, 'Dry/Wet': 100 }), x, x);
  const d = time * sr, whole = Math.floor(d), frac = d - whole;
  assert.ok(Math.abs(y.l[whole] - (1 - frac)) < 1e-6 && Math.abs(y.l[whole + 1] - frac) < 1e-6, `${y.l[whole]}, ${y.l[whole + 1]}`);
});

test('Dry/Wet mixes the input and the line as the native crossfade does', () => {
  const x = sine(SR, 440, 0.5);
  const y = run(set(new Delay(SR), { Time: 0.1, Feedback: 0, 'Dry/Wet': 25 }), x, x);
  const d = 0.1 * SR;
  for (let i = d; i < SR; i += 1001) assert.ok(Math.abs(y.l[i] - (0.75 * x[i] + 0.25 * x[i - d])) < 1e-6);
});

test('the tail is the time over the repeats to -60 dB', () => {
  const k = set(new Delay(SR), { Time: 0.5, Feedback: 50 });
  assert.equal(k.tail(), Math.ceil(0.5 * SR * 11));     // 10 halvings and the delay itself
  assert.equal(set(new Delay(SR), { Time: 0.5, Feedback: 0 }).tail(), 0.5 * SR);
});

test('a Time knob crossfades to the new tap in 10 ms: no click, no glide', () => {
  const k = set(new Delay(SR), { Time: 0.2, Feedback: 0, 'Dry/Wet': 100 });
  const x = sine(2 * SR, 1000, 0.5);
  const bl = new Float32Array(128), ol = new Float32Array(128), or = new Float32Array(128);
  const y = new Float32Array(2 * SR);
  const change = 7680;           // a block boundary after the line has filled
  for (let at = 0; at < x.length; at += 128) {
    if (at === change) k.set('Time', 0.4, at);
    bl.set(x.subarray(at, at + 128));
    k.process(bl, bl, ol, or, 128);
    y.set(ol, at);
  }
  let maxStep = 0;
  for (let i = 1; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
  const sineStep = 0.5 * 2 * Math.sin(Math.PI * 1000 / SR);   // the sine's own largest step
  assert.ok(maxStep < sineStep * 1.05, `the largest step is ${maxStep.toFixed(4)} against the sine's ${sineStep.toFixed(4)}`);
  // after the crossfade, the new tap exactly
  const after = change + Math.round(0.01 * SR) + 128;
  for (let i = after + 0.4 * SR; i < y.length; i += 997) assert.ok(Math.abs(y[i] - x[i - 0.4 * SR]) < 1e-6);
});

test('a Time lane bends the pitch, as an automated DelayNode does', () => {
  // the delay grows by 0.02 s over a second: what comes out is 2% slower
  const x = sine(3 * SR, 1000, 0.5);
  const k = set(new Delay(SR), { Time: 0.1, Feedback: 0, 'Dry/Wet': 100 });
  const blocks = Math.floor(x.length / 128);
  const y = run(k, x, x, [128], (b) => (b >= 375 && b < 750 ? new Map([['Time', [0.1 + ((b - 375) / 375) * 0.02, 0.1 + ((b + 1 - 375) / 375) * 0.02]]]) : undefined));
  assert.ok(blocks > 750);
  // zero crossings in the ramped second: 1000 Hz * 0.98 * 1 s * 2
  let crossings = 0;
  for (let i = SR + 0.15 * SR; i < 2 * SR + 0.05 * SR; i++) if ((y.l[i] >= 0) !== (y.l[i - 1] >= 0)) crossings++;
  const hz = crossings / 2 / 0.9;
  assert.ok(Math.abs(hz - 980) < 3, `${hz.toFixed(1)} Hz`);
  // and the delay is 0.12 s afterwards
  for (let i = 2.5 * SR; i < 3 * SR; i += 997) assert.ok(Math.abs(y.l[i] - x[i - 0.12 * SR]) < 1e-5);
});

test('once the repeats have fallen below -400 dB, the lines are empty for real', () => {
  const k = set(new Delay(SR), { Time: 0.1, Feedback: 50, 'Dry/Wet': 100 });
  const y = run(k, impulse(8 * SR), silence(8 * SR));   // 0.5^66 is below 1e-20 at 6.6 s
  assert.ok(y.l[6 * SR] !== 0, 'still ringing at 6 s');
  assert.ok(y.l.slice(7 * SR).every((v) => v === 0), 'empty at 7 s');
});
