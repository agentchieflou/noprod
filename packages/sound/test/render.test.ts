import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, midiToHz } from '../src/index.ts';
import type { Layer, SoundRecipe } from '../src/index.ts';
import {
  amplitudeAt, bandShare, estimatePitch, levelAt, loudness, peak, powerSpectrum, rms, spectralCentroid, toDb
} from '../src/analysis.ts';

const SR = 44100;

const recipe = (layers: Layer[], extra: Partial<SoundRecipe> = {}): SoundRecipe => ({
  id: 'test', name: 'Test', category: 'fx', pitched: true, root: 69, length: 1, layers, ...extra
});
const sine: Layer = { type: 'partials', partials: [{ ratio: 1, level: 1 }] };
const raw = { normalize: false, sampleRate: SR };

const near = (actual: number, expected: number, tolerance: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not within ${tolerance} of ${expected}`);

// --------------------------------------------------------------- frequency

test('a pitched sound plays at the frequency of the note', () => {
  const r = recipe([sine]);
  for (const note of [45, 57, 60, 69, 81, 93]) {
    const { left } = render(r, { ...raw, note, gate: 0.5 });
    near(estimatePitch(left, SR, 2205), midiToHz(note), midiToHz(note) * 0.001, `note ${note}:`);
  }
});

test('an unpitched sound ignores the note, and transpose retunes it', () => {
  const r = recipe([{ ...sine, hz: 200 }], { pitched: false, length: 0.5 });
  near(estimatePitch(render(r, { ...raw, note: 30 }).left, SR, 2205), 200, 0.2);
  near(estimatePitch(render(r, { ...raw, note: 90 }).left, SR, 2205), 200, 0.2);
  near(estimatePitch(render(r, { ...raw, transpose: 12 }).left, SR, 2205), 400, 0.4);
});

test("a saw's harmonics fall as 1/n", () => {
  const { left } = render(recipe([{ type: 'wave', shape: 'saw' }], { root: 45 }), { ...raw, gate: 0.5 });
  const f = midiToHz(45);
  const fundamental = amplitudeAt(left, SR, f, 2048, 8192);
  for (let n = 2; n <= 10; n++) {
    near(toDb(amplitudeAt(left, SR, f * n, 2048, 8192) / fundamental), -toDb(n) * 1, 0.3, `harmonic ${n}:`);
  }
});

test('a square has only odd harmonics', () => {
  const { left } = render(recipe([{ type: 'wave', shape: 'square' }], { root: 45 }), { ...raw, gate: 0.5 });
  const f = midiToHz(45);
  const fundamental = amplitudeAt(left, SR, f, 2048, 8192);
  near(toDb(amplitudeAt(left, SR, 3 * f, 2048, 8192) / fundamental), -toDb(3), 0.3, '3rd:');
  for (const n of [2, 4, 6]) {
    assert.ok(toDb(amplitudeAt(left, SR, n * f, 2048, 8192) / fundamental) < -50, `harmonic ${n} is audible`);
  }
});

// Energy away from the note's harmonics: anything there folded back from past Nyquist
function aliasedShare(x: Float32Array, hz: number) {
  const size = 8192;
  const power = powerSpectrum(x, 1024, size);
  let off = 0, total = 0;
  power.forEach((p, k) => {
    const f = (k * SR) / size;
    const harmonic = Math.round(f / hz);
    total += p;
    if (harmonic === 0 || Math.abs(f - harmonic * hz) > (6 * SR) / size) off += p;
  });
  return off / total;
}

test('nothing folds back from above Nyquist', () => {
  const note = 108; // 4186 Hz: only four harmonics fit below Nyquist
  const saw = render(recipe([{ type: 'wave', shape: 'saw' }]), { ...raw, note, gate: 0.5 }).left;
  assert.ok(aliasedShare(saw, midiToHz(note)) < 1e-4, 'the saw aliases');
  const series = render(recipe([{ type: 'partials', series: { count: 40 } }]), { ...raw, note, gate: 0.5 }).left;
  assert.ok(aliasedShare(series, midiToHz(note)) < 1e-4, 'the harmonic series aliases');
  const unison = render(recipe([{ type: 'wave', shape: 'square', unison: { voices: 3, detune: 10 } }]),
    { ...raw, note: 100, gate: 0.5 }).left;
  assert.ok(toDb(amplitudeAt(unison, SR, SR - 9 * midiToHz(100), 1024, 8192)) < -80, 'the 9th harmonic folds back');
});

test('stretch makes partials inharmonic, as in a piano string', () => {
  const r = recipe([{ type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 10, level: 1 }], stretch: 0.001 }]);
  const { left } = render(r, { ...raw, gate: 0.5 });
  const stretched = 440 * 10 * Math.sqrt(1 + 0.001 * 100);
  assert.ok(amplitudeAt(left, SR, stretched, 2048, 8192) > 0.4);
  assert.ok(amplitudeAt(left, SR, 4400, 2048, 8192) < 0.01);
});

// --------------------------------------------------------------- envelopes

test('attack and decay take the times written (decay is a T60)', () => {
  const { left } = render(recipe([{ ...sine, env: { attack: 0.1, decay: 0.5, sustain: 0 } }]), raw);
  const top = levelAt(left, SR, 0.1);
  assert.ok(levelAt(left, SR, 0.02) < top / 3, 'the attack is too fast');
  near(toDb(levelAt(left, SR, 0.6) / top), -60, 3, 'after one T60:');
});

test('a note releases from its gate and ends after its release', () => {
  const r = recipe([{ ...sine, env: { sustain: 1, release: 0.3 } }]);
  const { left } = render(r, { ...raw, gate: 0.5 });
  near(toDb(levelAt(left, SR, 0.65) / levelAt(left, SR, 0.45)), -30, 1.5, '0.15 s after the gate:');
  assert.equal(left.length, Math.ceil(0.8 * SR));
});

test('higher partials die sooner with damping', () => {
  const r = recipe([{
    type: 'partials', partialDecay: 1, damping: 1,
    partials: [{ ratio: 1, level: 1 }, { ratio: 3, level: 1 }]
  }]);
  const { left } = render(r, { ...raw, gate: 1 });
  const fall = (hz: number) => toDb(amplitudeAt(left, SR, hz, Math.round(0.3 * SR), 2048) / amplitudeAt(left, SR, hz, Math.round(0.05 * SR), 2048));
  near(fall(440), -15, 1.5, 'the fundamental after 0.25 s:');
  near(fall(1320), -45, 3, 'the 3rd partial after 0.25 s:');
});

test('a one-shot ends once it falls silent, and one its length cuts off fades out', () => {
  const short = render(recipe([{ type: 'noise', env: { decay: 0.2, sustain: 0 } }], { pitched: false, length: 5 }), raw);
  assert.ok(short.left.length < 0.45 * SR, `${short.left.length / SR} s is too long`);

  const cut = render(recipe([{ ...sine, hz: 440 }], { pitched: false, length: 0.2 }), raw);
  assert.equal(cut.left.length, Math.ceil(0.2 * SR));
  assert.ok(Math.abs(cut.left[cut.left.length - 1]) < 1e-3, 'the end clicks');
});

test('a layer can start late', () => {
  const { left } = render(recipe([sine, { ...sine, ratio: 2, start: 0.1 }]), { ...raw, gate: 0.3 });
  assert.ok(amplitudeAt(left, SR, 880, 0, Math.round(0.09 * SR)) < 0.01);
  assert.ok(amplitudeAt(left, SR, 880, Math.round(0.15 * SR), 4096) > 0.9);
});

// ------------------------------------------------------------------ pitch

test('a pitch envelope glides back to the written pitch', () => {
  const r = recipe([{ ...sine, hz: 50, pitch: { amount: 24, time: 0.15 } }], { pitched: false, length: 0.6 });
  const { left } = render(r, raw);
  assert.ok(estimatePitch(left, SR, 0, 1024, 30, 1000) > 120, 'it does not start high');
  near(estimatePitch(left, SR, Math.round(0.3 * SR), 8192, 30, 1000), 50, 0.5, 'after the glide:');
});

test('vibrato wobbles around the note', () => {
  const { left } = render(recipe([{ ...sine, vibrato: { rate: 5, depth: 50 } }]), { ...raw, gate: 1 });
  const cents = [];
  for (let t = 0.1; t < 0.9; t += 0.025) cents.push(1200 * Math.log2(estimatePitch(left, SR, Math.round(t * SR), 1024) / 440));
  near(Math.max(...cents), 50, 8, 'the top:');
  near(Math.min(...cents), -50, 8, 'the bottom:');
});

// ---------------------------------------------------------------- filters

test('a lowpass darkens the sound and its envelope opens and closes it', () => {
  const saw: Layer = { type: 'wave', shape: 'saw' };
  const r = (layer: Layer) => render(recipe([layer], { root: 45 }), { ...raw, gate: 1 }).left;
  const f = midiToHz(45);
  const harmonic20 = (x: Float32Array) => amplitudeAt(x, SR, 20 * f, 4096, 8192) / amplitudeAt(x, SR, f, 4096, 8192);
  assert.ok(toDb(harmonic20(r({ ...saw, filter: { type: 'lowpass', cutoff: 500 } })) / harmonic20(r(saw))) < -20);

  const swept = r({ ...saw, filter: { type: 'lowpass', cutoff: 300, env: { amount: 4, decay: 0.3, sustain: 0 } } });
  const tenth = (at: number) => toDb(amplitudeAt(swept, SR, 10 * f, Math.round(at * SR), 2048) / amplitudeAt(swept, SR, f, Math.round(at * SR), 2048));
  assert.ok(tenth(0) > tenth(0.6) + 15, 'the envelope does not sweep the cutoff');
});

test('key tracking moves the cutoff with the note', () => {
  const layer = (keyTrack: number): Layer => ({ type: 'wave', shape: 'saw', filter: { type: 'lowpass', cutoff: 600, keyTrack } });
  const brightness = (keyTrack: number, note: number) => {
    const { left } = render(recipe([layer(keyTrack)]), { ...raw, note, gate: 0.5 });
    const f = midiToHz(note);
    return toDb(amplitudeAt(left, SR, 3 * f, 2048, 8192) / amplitudeAt(left, SR, f, 2048, 8192));
  };
  near(brightness(1, 81), brightness(1, 69), 0.5, 'tracked:');
  assert.ok(brightness(0, 81) < brightness(0, 69) - 3, 'a fixed cutoff should darken high notes');
});

test('noise stays in its band, and pink and brown lean low', () => {
  const band = render(recipe([{ type: 'noise', filter: { type: 'bandpass', cutoff: 1000, q: 4, slope: 24 } }], { pitched: false }), raw).left;
  assert.ok(bandShare(band, SR, 700, 1400) > 0.8);
  const high = render(recipe([{ type: 'noise', filter: { type: 'highpass', cutoff: 6000, slope: 24 } }], { pitched: false }), raw).left;
  assert.ok(bandShare(high, SR, 4000, SR / 2) > 0.95);

  const centroid = (color: 'white' | 'pink' | 'brown') =>
    spectralCentroid(render(recipe([{ type: 'noise', color }], { pitched: false }), raw).left, SR, 4096, 8192);
  assert.ok(centroid('white') > centroid('pink') && centroid('pink') > centroid('brown'));
});

// ---------------------------------------------------------------------- fm

test('FM sidebands follow the Bessel functions', () => {
  const { left } = render(recipe([{ type: 'fm', modRatio: 3, index: 1 }], { root: 45 }), { ...raw, gate: 0.5 });
  const f = midiToHz(45);
  const carrier = amplitudeAt(left, SR, f, 2048, 8192);
  near(amplitudeAt(left, SR, 4 * f, 2048, 8192) / carrier, 0.44005 / 0.76520, 0.01, 'J1/J0:');
  near(amplitudeAt(left, SR, 7 * f, 2048, 8192) / carrier, 0.11490 / 0.76520, 0.01, 'J2/J0:');
});

// ----------------------------------------------------------- level & space

test('pan places a layer; unison spreads its voices', () => {
  const left = render(recipe([{ ...sine, pan: -1 }]), { ...raw, gate: 0.2 });
  assert.equal(rms(left.right), 0);
  near(rms(left.left, 0, 4410), 1, 0.01, 'hard left (equal power, unity at the centre):');

  const wide = render(recipe([{ type: 'wave', shape: 'saw', unison: { voices: 5, detune: 20, spread: 1 } }]), { ...raw, gate: 0.5 });
  let same = true;
  for (let i = 0; i < wide.left.length && same; i++) same = wide.left[i] === wide.right[i];
  assert.ok(!same, 'unison spread left the sound mono');
  const narrow = render(recipe([{ type: 'wave', shape: 'saw', unison: { voices: 5, detune: 20 } }]), { ...raw, gate: 0.5 });
  assert.deepEqual(narrow.left, narrow.right);
});

test('drive adds harmonics without raising the peak', () => {
  const { left } = render(recipe([{ ...sine, drive: 4 }]), { ...raw, gate: 0.3 });
  assert.ok(peak(left) <= 1 + 1e-6);
  assert.ok(toDb(amplitudeAt(left, SR, 1320, 2048, 8192) / amplitudeAt(left, SR, 440, 2048, 8192)) > -20);
});

test('sounds are normalized to the same loudness, and velocity and gain change it', () => {
  const sustained = render(recipe([sine]), { gate: 1 });
  near(loudness(sustained.left, sustained.right, SR), -12, 0.05, 'a sustained sound reads');
  const bright = render(recipe([{ ...sine, ratio: 8 }]), { gate: 1 });
  assert.ok(peak(bright.left) < peak(sustained.left), 'K-weighting should turn a 3.5 kHz tone down against 440 Hz');

  const click = recipe([{ type: 'noise', env: { decay: 0.02, sustain: 0 } }], { pitched: false });
  near(toDb(Math.max(peak(render(click).left), peak(render(click).right))), -1, 0.01, 'a click peaks at');

  const level = (options = {}, extra = {}) => rms(render(recipe([sine], extra), { gate: 0.5, ...options }).left, 4410, 8820);
  near(toDb(level({ velocity: 0.5 }) / level()), -12.04, 0.1, 'half velocity:');
  near(toDb(level({}, { gain: 6 }) / level()), 6, 0.01, '+6 dB gain:');
});

test('the same recipe always renders the same samples; the seed changes the noise', () => {
  const noisy = (seed?: number) => recipe([{ type: 'noise' }, { type: 'wave', unison: { voices: 3, detune: 15, spread: 1 } }],
    { seed, length: 0.2 });
  assert.deepEqual(render(noisy()), render(noisy()));
  assert.notDeepEqual(render(noisy(1)).left, render(noisy(2)).left);
});

test('every kind of layer renders finite samples at any note and velocity', () => {
  const everything = recipe([
    { type: 'partials', series: { count: 30, slope: -3, even: 0.5 }, stretch: 0.0004, partialDecay: 2, damping: 0.8, phases: 'random' },
    { type: 'wave', shape: 'pulse', width: 0.1, ratios: [1, 1.5], unison: { voices: 4, detune: 25, spread: 0.7 }, vibrato: { rate: 6, depth: 20, delay: 0.1, fade: 0.2 } },
    { type: 'fm', modRatio: 1.41, index: 4, indexEnv: { decay: 0.4, sustain: 0.2 }, feedback: 0.4, drive: 2 },
    { type: 'noise', color: 'pink', stereo: true, start: 0.05, filter: [{ type: 'highpass', cutoff: 200 }, { type: 'notch', cutoff: 3000, q: 2 }] }
  ], { length: 0.5 });
  for (const note of [0, 21, 60, 108, 127]) {
    for (const velocity of [0, 0.3, 1]) {
      const { left, right } = render(everything, { note, velocity, gate: 0.2, sampleRate: 22050 });
      for (let i = 0; i < left.length; i++) assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]));
    }
  }
});
