// The time-stretcher, measured: lengths, pitch, attacks, clicks, formants,
// the stereo image and speed. Each is measured against the overlap-add
// grains the frontend's warped clips used before (`grains` below, as
// apps/frontend/src/audio/clipPlayback.ts schedules them), and printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, stretch, Stretcher } from '../src/index.ts';
import type { StretchMode } from '../src/index.ts';
import { findSound } from '../src/library/index.ts';
import { amplitudeAt, periodicity, rms } from '../src/analysis.ts';
import { midiToHz } from '../src/dsp.ts';

const SR = 48000;
const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);
const sine = (hz: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
// A sawtooth-like tone: ten harmonics at 1/h
const harmonic = (hz: number, seconds: number) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let h = 1; h <= 10; h++) for (let i = 0; i < x.length; i++) x[i] += (0.3 / h) * Math.sin((2 * Math.PI * h * hz * i) / SR + h);
  return x;
};

// A frequency to a fraction of a cent: where a Hann-windowed DTFT peaks
// near `guess`, by golden-section search
function frequency(x: Float32Array, guess: number, start = Math.round(x.length / 2) - 16384, length = 32768) {
  let lo = guess * 0.98, hi = guess * 1.02;
  for (let i = 0; i < 60; i++) {
    const a = hi - (hi - lo) / 1.618, b = lo + (hi - lo) / 1.618;
    if (amplitudeAt(x, SR, a, start, length) > amplitudeAt(x, SR, b, start, length)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

// The old warp: overlap-add grains read at the tempo ratio, each resampled
// by the pitch factor (Beats: 50 ms grains every 25 ms, ramps of 12.5 ms)
function grains(x: Float32Array, ratio: number, pitch = 1, grain = 0.05) {
  const out = new Float32Array(Math.round(x.length * ratio));
  const hop = grain / 2, n = Math.round(grain * SR), ramp = Math.round((hop / 2) * SR);
  for (let t = 0; t * SR < out.length; t += hop) {
    const start = Math.round(t * SR), src = (t / ratio) * SR;
    for (let i = 0; i < n && start + i < out.length; i++) {
      const g = i < ramp ? i / ramp : i > n - ramp ? (n - i) / ramp : 1;
      const p = src + i * pitch, j = Math.floor(p);
      const v = j + 1 < x.length ? x[j] + (x[j + 1] - x[j]) * (p - j) : 0;
      out[start + i] += v * g;
    }
  }
  return out;
}

const report = (t: { diagnostic: (m: string) => void }, lines: string[]) => lines.forEach((l) => t.diagnostic(l));

test('the output is exactly length × ratio long, and pitch shifts keep the length', () => {
  const x = harmonic(220, 1.3);
  for (const ratio of [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]) {
    const [y] = stretch([x], { sampleRate: SR, ratio });
    assert.equal(y.length, Math.round(x.length * ratio), `ratio ${ratio}`);
  }
  for (const semitones of [-12, -5, 7, 12]) {
    const [y] = stretch([x], { sampleRate: SR, semitones });
    assert.equal(y.length, x.length, `${semitones} semitones`);
  }
});

test('stretching keeps the pitch: a sine and a harmonic tone, within 2 cents', (t) => {
  const lines: string[] = [];
  for (const [name, x, hz] of [['sine 440', sine(440, 3), 440], ['harmonic 220', harmonic(220, 3), 220]] as const) {
    const ref = frequency(x, hz);
    for (const mode of ['complex', 'beats', 'tones'] as StretchMode[]) {
      for (const ratio of [0.5, 0.8, 1.25, 2]) {
        const [y] = stretch([x], { sampleRate: SR, ratio, mode });
        const off = cents(frequency(y, hz), ref);
        assert.ok(Math.abs(off) <= 2, `${name}, ${mode}, ratio ${ratio}: ${off.toFixed(3)} cents`);
        if (mode === 'complex') {
          const old = cents(frequency(grains(x, ratio), hz), ref);
          // How much of the tone stays one clean partial (grains spread it into sidebands)
          const clean = (z: Float32Array) => amplitudeAt(z, SR, hz, Math.round(z.length / 2) - 16384, 32768) / amplitudeAt(x, SR, hz, SR, 32768);
          lines.push(`${name} ×${ratio}: ${off.toFixed(3)} cents, fundamental at ${clean(y).toFixed(3)} of its level; grains ${old.toFixed(3)} cents, ${clean(grains(x, ratio)).toFixed(3)}`);
        }
      }
    }
  }
  report(t, lines);
});

test('a library sound stretched stays in tune by the library test\'s measure', () => {
  for (const id of ['organ-drawbar', 'strings-ensemble', 'flute-modeled']) {
    const r = findSound(id)!;
    const note = r.root ?? 60;
    const { left, right } = render(r, { sampleRate: SR, note, gate: 1.2 });
    const hz = midiToHz(note);
    for (const ratio of [0.8, 1.25]) {
      const [y] = stretch([left, right], { sampleRate: SR, ratio });
      const at = Math.round(0.4 * ratio * SR);
      const once = periodicity(y, SR, hz, at, 4096);
      const twice = periodicity(y, SR, hz * 2, at, 4096);
      assert.ok(once < 0.15, `${id} ×${ratio} doesn't repeat at ${hz.toFixed(1)} Hz (${once.toFixed(3)})`);
      assert.ok(twice > 0.08, `${id} ×${ratio} sounds an octave up (${twice.toFixed(3)})`);
    }
  }
});

test('pitch shifts of up to an octave either way land within 2 cents, at the same length', (t) => {
  const lines: string[] = [];
  for (const [name, x, hz] of [['sine 440', sine(440, 3), 440], ['harmonic 220', harmonic(220, 3), 220]] as const) {
    const ref = frequency(x, hz);
    for (const semitones of [-12, -7, -1, 1, 5, 12]) {
      const [y] = stretch([x], { sampleRate: SR, semitones });
      const want = ref * 2 ** (semitones / 12);
      const off = cents(frequency(y, want), want);
      assert.equal(y.length, x.length);
      assert.ok(Math.abs(off) <= 2, `${name} ${semitones > 0 ? '+' : ''}${semitones}: ${off.toFixed(3)} cents`);
      const old = cents(frequency(grains(x, 1, 2 ** (semitones / 12)), want), want);
      lines.push(`${name} ${semitones > 0 ? '+' : ''}${semitones} st: ${off.toFixed(3)} cents; grains ${old.toFixed(3)} cents`);
    }
  }
  report(t, lines);
});

// Two bars of kick, snare and closed hat at 120 BPM, from the library
function drumLoop() {
  const hits: [string, number][] = [];
  for (let b = 0; b < 8; b++) {
    hits.push([b % 2 ? 'snare-acoustic' : 'kick-punchy', 0.2 + b * 0.5]);
    hits.push(['hat-closed', 0.45 + b * 0.5]);
  }
  const length = Math.round(4.4 * SR);
  const left = new Float32Array(length), right = new Float32Array(length);
  for (const [id, t] of hits) {
    const r = render(findSound(id)!, { sampleRate: SR });
    const at = Math.round(t * SR);
    for (let i = 0; i < r.left.length && at + i < length; i++) {
      left[at + i] += r.left[i] * 0.5;
      right[at + i] += r.right[i] * 0.5;
    }
  }
  return { left, right, onsets: hits.map((h) => h[1]).sort((a, b) => a - b) };
}

// An attack near `time`: its peak (0.5 ms peak envelope), when it comes,
// and its rise time from 10% to 90% of that peak
function attack(x: Float32Array, time: number) {
  const block = Math.round(SR * 0.0005);
  const env = (b: number) => {
    let p = 0;
    for (let i = b * block; i < (b + 1) * block && i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
    return p;
  };
  const from = Math.round(((time - 0.01) * SR) / block), to = Math.round(((time + 0.03) * SR) / block);
  let top = from;
  for (let b = from; b < to; b++) if (env(b) > env(top)) top = b;
  let high = top;
  while (high > from && env(high) >= 0.9 * env(top)) high--;
  let low = high;
  while (low > from - 40 && env(low) >= 0.1 * env(top)) low--;
  return { peak: env(top), at: (top * block) / SR, rise: ((high - low) * block * 1000) / SR };
}

test('a drum loop stretched keeps its attacks: rise times, peaks and timing', (t) => {
  const loop = drumLoop();
  const lines: string[] = [];
  for (const [mode, ratio] of [['complex', 1.5], ['beats', 1.5], ['complex', 0.75], ['complex', 2]] as [StretchMode, number][]) {
    const [y] = stretch([loop.left, loop.right], { sampleRate: SR, ratio, mode });
    const old = grains(loop.left, ratio);
    let worstRise = 0, worstPeak = 0, worstTime = 0, sumRise = 0, sumOld = 0, sumOrig = 0, worstOld = 0, worstOldPeak = 0;
    for (const onset of loop.onsets) {
      const a = attack(loop.left, onset), b = attack(y, onset * ratio), g = attack(old, onset * ratio);
      worstRise = Math.max(worstRise, Math.abs(b.rise - a.rise));
      worstPeak = Math.max(worstPeak, Math.abs(20 * Math.log10(b.peak / a.peak)));
      worstTime = Math.max(worstTime, Math.abs(b.at - a.at * ratio) * 1000);
      worstOld = Math.max(worstOld, Math.abs(g.rise - a.rise));
      worstOldPeak = Math.max(worstOldPeak, Math.abs(20 * Math.log10(g.peak / a.peak)));
      sumRise += b.rise; sumOld += g.rise; sumOrig += a.rise;
    }
    const n = loop.onsets.length, what = `${mode} ×${ratio}`;
    // Within 1.5 ms of the original's rise, its peak within 1 dB, and on time to 2 ms
    assert.ok(worstRise <= 1.5, `${what}: a rise time is ${worstRise.toFixed(2)} ms off the original's`);
    assert.ok(worstPeak <= 1, `${what}: a peak is ${worstPeak.toFixed(2)} dB off`);
    assert.ok(worstTime <= 2, `${what}: an attack is ${worstTime.toFixed(2)} ms late or early`);
    // and clearly better than the grains
    assert.ok(sumRise * 3 < sumOld, `${what}: rise ${sumRise / n} ms against the grains' ${sumOld / n} ms`);
    lines.push(`${what}: mean rise ${(sumRise / n).toFixed(2)} ms (original ${(sumOrig / n).toFixed(2)} ms, grains ${(sumOld / n).toFixed(2)} ms); ` +
      `worst rise error ${worstRise.toFixed(2)} ms (grains ${worstOld.toFixed(2)} ms), worst peak ${worstPeak.toFixed(2)} dB (grains ${worstOldPeak.toFixed(2)} dB), timing ${worstTime.toFixed(2)} ms`);
  }
  report(t, lines);
});

// The largest step from one sample to the next
const maxStep = (x: Float32Array, from = 0, to = x.length) => {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

test('a sustained tone comes out without clicks', (t) => {
  // Three partials: the largest step of the input is about 0.13
  const x = new Float32Array(3 * SR);
  for (let i = 0; i < x.length; i++) {
    const p = (2 * Math.PI * 330 * i) / SR;
    x[i] = 0.4 * Math.sin(p) + 0.2 * Math.sin(2 * p + 1) + 0.1 * Math.sin(3 * p + 2);
  }
  const limit = maxStep(x) * 1.25;
  const lines: string[] = [];
  for (const [what, options] of [
    ['×0.8', { ratio: 0.8 }], ['×1.5', { ratio: 1.5 }], ['×2', { ratio: 2 }], ['+7 st', { semitones: 7 }], ['−5 st', { semitones: -5 }]
  ] as const) {
    const [y] = stretch([x], { sampleRate: SR, ...options });
    // Away from the very start and end, where the tone itself starts and stops
    const step = maxStep(y, SR / 10, y.length - SR / 10);
    const ratio = 'ratio' in options ? options.ratio : 1, pitch = 'semitones' in options ? 2 ** (options.semitones / 12) : 1;
    const old = grains(x, ratio, pitch);
    const oldStep = maxStep(old, SR / 10, old.length - SR / 10);
    // (a step scales with pitch: shifted up, the tone is steeper)
    assert.ok(step <= limit * Math.max(1, pitch), `${what}: a step of ${step.toFixed(4)} (input ${maxStep(x).toFixed(4)})`);
    lines.push(`${what}: largest step ${step.toFixed(4)} (input ${maxStep(x).toFixed(4)}, grains ${oldStep.toFixed(4)})`);
  }
  report(t, lines);
});

// A vowel-like sound: 140 Hz harmonics under three formants (as an /a/)
const FORMANTS = [[700, 150, 1], [1150, 150, 0.6], [2600, 200, 0.3]];
const vowelEnvelope = (hz: number) => FORMANTS.reduce((s, [f, bw, a]) => s + a / (1 + ((hz - f) / bw) ** 2), 0.01);
function vowel(f0: number, seconds: number) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let h = 1; h * f0 < 6000; h++) {
    const a = 0.1 * vowelEnvelope(h * f0);
    for (let i = 0; i < x.length; i++) x[i] += a * Math.sin((2 * Math.PI * h * f0 * i) / SR + h * h * 0.7);
  }
  return x;
}

// The spectral envelope's peaks: each harmonic's level, then a parabola
// (in log) through the strongest harmonic near each formant and its two
// neighbours
function formantPeaks(x: Float32Array, f0: number) {
  const levels: number[] = [];
  for (let h = 1; h * f0 < 6000; h++) levels.push(Math.log(amplitudeAt(x, SR, h * f0, SR / 2, 16384) + 1e-9));
  return FORMANTS.map(([f]) => {
    let best = -1;
    for (let i = 1; i < levels.length - 1; i++) {
      if (Math.abs((i + 1) * f0 - f) <= f * 0.2 && levels[i] >= levels[i - 1] && levels[i] >= levels[i + 1] && (best < 0 || levels[i] > levels[best])) best = i;
    }
    if (best < 0) return NaN;
    const [a, b, c] = [levels[best - 1], levels[best], levels[best + 1]];
    return (best + 1 + (a - c) / (2 * (a - 2 * b + c))) * f0;
  });
}

test('a vowel shifted up 5 semitones with formants kept keeps its formants', (t) => {
  const x = vowel(140, 2);
  const up = 140 * 2 ** (5 / 12);
  const before = formantPeaks(x, 140);
  const [kept] = stretch([x], { sampleRate: SR, semitones: 5, formants: true });
  const [moved] = stretch([x], { sampleRate: SR, semitones: 5 });
  const after = formantPeaks(kept, up), shifted = formantPeaks(moved, up), old = formantPeaks(grains(x, 1, 2 ** (5 / 12)), up);
  // What the measure reads on the right answer: the same vowel at the new pitch
  const ideal = formantPeaks(vowel(up, 2), up);
  const off = (v: number[]) => v.map((hz, i) => (Number.isNaN(hz) ? 'gone' : `${(((hz - before[i]) / before[i]) * 100).toFixed(1)}%`)).join(', ');
  FORMANTS.forEach(([f], i) => {
    // Within 10%: harmonics 187 Hz apart only sample the envelope so finely
    // (the right answer itself reads up to 4% off)
    assert.ok(Math.abs(after[i] - before[i]) <= before[i] * 0.1, `formant ${f}: ${after[i].toFixed(0)} Hz, was ${before[i].toFixed(0)} Hz`);
  });
  // Without them kept, the first formant moves up with the pitch, out of reach
  assert.ok(Number.isNaN(shifted[0]) || shifted[0] > before[0] * 1.2, `unkept, the first formant stayed at ${shifted[0]}`);
  report(t, [
    `formant peaks ${before.map((v) => v.toFixed(0)).join(', ')} Hz; kept: ${off(after)} (the right answer reads ${off(ideal)}); ` +
    `not kept: ${off(shifted)}; grains: ${off(old)}`
  ]);
});

test('the stereo image stays: level and phase differences between channels', () => {
  // A source panned left, the right channel a quarter-period later and quieter
  const n = 2 * SR;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * 300 * i) / SR;
    left[i] = 0.4 * Math.sin(p) + 0.2 * Math.sin(2.01 * p);
    right[i] = 0.2 * Math.sin(p - Math.PI / 2) + 0.1 * Math.sin(2.01 * p - Math.PI / 2);
  }
  // The lag where the channels' cross-correlation peaks, over one period
  const lagOf = (l: Float32Array, r: Float32Array, at: number, period: number) => {
    let best = -Infinity, bestLag = 0;
    for (let lag = 0; lag < period; lag++) {
      let c = 0;
      for (let i = at; i < at + 8192; i++) c += l[i] * r[i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag;
  };
  const inputLag = lagOf(left, right, SR / 2, SR / 300);
  for (const options of [{ ratio: 1.5 }, { ratio: 0.8 }, { semitones: 4 }] as { ratio?: number; semitones?: number }[]) {
    const [l, r] = stretch([left, right], { sampleRate: SR, ...options });
    const mid = Math.round(l.length / 2);
    const level = 20 * Math.log10(rms(r, mid, 8192) / rms(l, mid, 8192));
    assert.ok(Math.abs(level - 20 * Math.log10(0.5)) < 0.2, `${JSON.stringify(options)}: right is ${level.toFixed(2)} dB from left`);
    // (a shift scales the lag with the period)
    const pitch = 2 ** ((options.semitones ?? 0) / 12);
    const lag = lagOf(l, r, mid, SR / 300 / pitch);
    assert.ok(Math.abs(lag - inputLag / pitch) <= 1, `${JSON.stringify(options)}: lag ${lag} samples, want ${(inputLag / pitch).toFixed(1)}`);
  }
  // And channels in opposite phase stay exactly opposite
  const [l, r] = stretch([left, left.map((v) => -v)], { sampleRate: SR, ratio: 1.3 });
  for (let i = 0; i < l.length; i++) assert.equal(r[i], -l[i]);
});

test('the same input and settings give the same output, block by block too', () => {
  const loop = drumLoop();
  const options = { sampleRate: SR, ratio: 1.3, semitones: 2, formants: true };
  const a = stretch([loop.left, loop.right], options);
  const b = stretch([loop.left, loop.right], options);
  assert.deepEqual(a, b);
  // Fed in uneven blocks and read as it goes, as an AudioWorklet would
  const s = new Stretcher(2, options);
  const out = [new Float32Array(a[0].length), new Float32Array(a[0].length)];
  let read = 0;
  const take = () => { read += s.read([out[0].subarray(read), out[1].subarray(read)]); };
  for (let at = 0, k = 0; at < loop.left.length; k++) {
    const size = [128, 1000, 37, 4096][k % 4];
    s.write([loop.left.subarray(at, at + size), loop.right.subarray(at, at + size)]);
    at += size;
    take();
  }
  s.end();
  take();
  assert.equal(read, a[0].length);
  assert.deepEqual(out, a);
});

test('a ratio of 1 with no shift passes the input through', () => {
  const x = harmonic(220, 0.5);
  assert.deepEqual(stretch([x], { sampleRate: SR })[0], x);
});

test('stereo 48 kHz stretches at least 10× faster than realtime', (t) => {
  const left = harmonic(110, 10), right = harmonic(165, 10);
  const lines: string[] = [];
  let warp = 0;
  for (const [what, options] of [
    ['complex ×1.25', { ratio: 1.25 }], ['beats ×1.25', { ratio: 1.25, mode: 'beats' }], ['tones ×1.25', { ratio: 1.25, mode: 'tones' }],
    ['complex ×0.8', { ratio: 0.8 }], ['+12 st', { semitones: 12 }], ['+5 st, formants kept', { semitones: 5, formants: true }]
  ] as const) {
    stretch([left.subarray(0, SR), right.subarray(0, SR)], { sampleRate: SR, ...options }); // warm up
    const start = performance.now();
    stretch([left, right], { sampleRate: SR, ...options });
    const speed = 10000 / (performance.now() - start);
    if (what === 'complex ×1.25') warp = speed;
    lines.push(`${what}: ${speed.toFixed(1)}× realtime`);
  }
  report(t, lines);
  assert.ok(warp >= 10, `complex ×1.25 runs at ${warp.toFixed(1)}× realtime`);
});
