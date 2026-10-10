import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, resynthesize, spectralDistance } from '../src/index.ts';
import type { Layer, NoiseLayer, PartialsLayer, SoundRecipe } from '../src/index.ts';
import { findSound } from '../src/library/index.ts';

const SR = 44100;
const mono = (r: SoundRecipe, gate?: number) => {
  const { left, right } = render(r, { sampleRate: SR, normalize: false, gate });
  return left.map((x, i) => (x + right[i]) / 2);
};
const recipe = (layers: Layer[], extra: Partial<SoundRecipe> = {}): SoundRecipe =>
  ({ id: 'source', name: 'Source', category: 'fx', pitched: true, root: 69, length: 3, layers, ...extra });
const partialsOf = (r: SoundRecipe) => (r.layers.find((l) => l.type === 'partials') as PartialsLayer).partials!;
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('a harmonic tone comes back as its partials: pitch, ratios, levels and decays', () => {
  const source = recipe([{ type: 'partials', partials: [
    { ratio: 1, level: 1, decay: 2 }, { ratio: 2, level: 0.5, decay: 1 }, { ratio: 3, level: 0.25, decay: 0.5 }
  ], env: { attack: 0.001, sustain: 1, release: 0.2 } }]);
  const out = resynthesize(mono(source, 3), SR);
  assert.equal(out.pitched, true);
  assert.equal(out.root, 69);
  const p = partialsOf(out).slice().sort((a, b) => b.level - a.level).slice(0, 3).sort((a, b) => a.ratio - b.ratio);
  [1, 2, 3].forEach((ratio, i) => near(p[i].ratio, ratio, ratio * 0.005, `partial ${i + 1} ratio`));
  near(20 * Math.log10(p[1].level / p[0].level), -6.02, 1.5, '2nd partial level (dB)');
  near(20 * Math.log10(p[2].level / p[0].level), -12.04, 1.5, '3rd partial level (dB)');
  [2, 1, 0.5].forEach((decay, i) => near(p[i].decay!, decay, decay * 0.2, `partial ${i + 1} decay`));
});

test('an inharmonic tone stays unpitched, at its own frequencies', () => {
  const source = recipe([{ type: 'partials', hz: 440, partials: [
    { ratio: 1, level: 1, decay: 2 }, { ratio: 2.76, level: 0.6, decay: 1.2 }, { ratio: 5.4, level: 0.4, decay: 0.6 }
  ], env: { attack: 0.001, sustain: 1 } }], { pitched: false });
  const out = resynthesize(mono(source), SR);
  assert.equal(out.pitched, false);
  const layer = out.layers.find((l) => l.type === 'partials') as PartialsLayer;
  near(layer.hz!, 440, 2, 'base frequency');
  const ratios = layer.partials!.slice().sort((a, b) => b.level - a.level).slice(0, 3).map((x) => x.ratio).sort((a, b) => a - b);
  [1, 2.76, 5.4].forEach((r, i) => near(ratios[i], r, r * 0.01, `ratio ${i + 1}`));
});

test('noise comes back as a noise band where it was, decaying as it did', () => {
  const source = recipe([{ type: 'noise', env: { attack: 0.001, decay: 0.6, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2400, q: 2 } }],
    { pitched: false, length: 1.5 });
  const out = resynthesize(mono(source), SR);
  const bands = out.layers.filter((l): l is NoiseLayer => l.type === 'noise');
  assert.ok(bands.length > 0, 'no noise bands');
  const loudest = bands.slice().sort((a, b) => (b.level ?? 1) - (a.level ?? 1))[0];
  const cutoff = (loudest.filter as { cutoff: number }).cutoff;
  assert.ok(cutoff > 1600 && cutoff < 3500, `the loudest band is centred at ${cutoff} Hz`);
  near(loudest.env!.decay!, 0.6, 0.25, 'its decay');
  assert.ok(spectralDistance(mono(source), mono(out), SR) < 8);
});

test('a held note sustains for as long as the recording held it, then releases', () => {
  const source = recipe([{ type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.4 }, { ratio: 3, level: 0.2 }],
    env: { attack: 0.01, sustain: 1, release: 0.3 } }]);
  const out = resynthesize(mono(source, 1), SR);
  assert.equal(out.pitched, true);
  near(out.length, 1, 0.1, 'held for');
  const env = out.layers[0].env!;
  assert.equal(env.sustain, 1);
  near(env.release!, 0.3, 0.15, 'release');
  assert.ok(spectralDistance(mono(source, 1), mono(out), SR) < 4);
});

// How close resynthesis gets, sound by sound: the mean spectrogram
// difference (dB) between a library sound and its resynthesis. Unison and
// chorus (several voices beating) are what a partial per harmonic misses most.
const BOUNDS: [string, number][] = [
  ['marimba', 2], ['cowbell', 2], ['kick-808', 3], ['organ-drawbar', 4], ['harp', 4], ['bass-sub', 4],
  ['piano-grand', 5], ['flute', 7], ['snare-acoustic', 9], ['hat-closed', 10], ['clap', 9], ['pad-warm', 16]
];

test('library sounds resynthesize close to themselves', () => {
  for (const [id, bound] of BOUNDS) {
    const r = findSound(id)!;
    const gate = r.pitched ? 1.5 : undefined;
    const source = mono(r, gate);
    const out = resynthesize(source, SR, { name: r.name });
    if (r.pitched) assert.equal(out.root, r.root, `${id} came back at ${out.root}`);
    const distance = spectralDistance(source, mono(out, gate), SR);
    assert.ok(distance < bound, `${id}: ${distance.toFixed(1)} dB (bound ${bound})`);
  }
});

test('silence and very short sounds resynthesize without trouble', () => {
  for (const samples of [new Float32Array(4410), Float32Array.from({ length: 300 }, (_, i) => Math.sin(i))]) {
    const out = resynthesize(samples, SR);
    const { left } = render(out, { sampleRate: SR });
    for (const x of left) assert.ok(Number.isFinite(x));
  }
});
