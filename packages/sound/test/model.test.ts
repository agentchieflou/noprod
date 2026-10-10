import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, midiToHz } from '../src/index.ts';
import type { Exciter, Layer, ModelLayer, Radiator, Resonator, SoundRecipe } from '../src/index.ts';
import { amplitudeAt, estimatePitch, levelAt, peak, spectralCentroid, toDb } from '../src/analysis.ts';

const SR = 44100;
const recipe = (layers: Layer[], extra: Partial<SoundRecipe> = {}): SoundRecipe =>
  ({ id: 'model', name: 'Model', category: 'strings', pitched: true, root: 60, length: 2, layers, ...extra });
const model = (exciter: Exciter, resonator: Resonator, extra: Partial<ModelLayer> = {}): ModelLayer =>
  ({ type: 'model', exciter, resonator, env: { attack: 0.02, sustain: 1, release: 0.05 }, ...extra });
const raw = (r: SoundRecipe, note = r.root ?? 60, gate = 1) => render(r, { note, gate, sampleRate: SR, normalize: false }).left;
const cents = (hz: number, note: number) => 1200 * Math.log2(hz / midiToHz(note));

const PAIRS: [string, ModelLayer, number][] = [
  ['plucked string', model({ kind: 'pluck' }, { kind: 'string', decay: 2 }), 60],
  ['struck string', model({ kind: 'strike' }, { kind: 'string', decay: 3 }), 60],
  ['bowed string', model({ kind: 'bow' }, { kind: 'string', decay: 1 }, { env: { attack: 0.08, sustain: 1, release: 0.1 } }), 60],
  ['lips on a flared bore', model({ kind: 'lips' }, { kind: 'bore', end: 'flared' }), 60],
  ['jet on an open bore', model({ kind: 'jet' }, { kind: 'bore', end: 'open' }), 72],
  ['reed on an open bore', model({ kind: 'reed' }, { kind: 'bore', end: 'open' }), 60]
];

test('every model plays in tune, an octave either side', () => {
  for (const [name, layer, root] of PAIRS) {
    for (const note of [root - 12, root, root + 12]) {
      const x = raw(recipe([layer], { root }), note);
      const hz = estimatePitch(x, SR, Math.round(0.6 * SR), 4096, 40, 3000);
      assert.ok(Math.abs(cents(hz, note)) < 20, `${name} at ${note}: ${cents(hz, note).toFixed(1)} cents`);
    }
  }
});

test('a plucked string rings down at its T60 and is damped on release', () => {
  const x = raw(recipe([model({ kind: 'pluck' }, { kind: 'string', decay: 1.5 }, { env: { sustain: 1, release: 0.1 } })]), 60, 1.5);
  // the fundamental's own decay (the upper harmonics die sooner)
  const f = midiToHz(60);
  const fall = toDb(amplitudeAt(x, SR, f, Math.round(0.7 * SR), 4096) / amplitudeAt(x, SR, f, Math.round(0.2 * SR), 4096));
  assert.ok(fall < -16 && fall > -24, `0.5 s fell ${fall.toFixed(1)} dB (T60 1.5 s: -20)`);
  assert.ok(levelAt(x, SR, 1.75, 0.05) < levelAt(x, SR, 1.4, 0.05) * 0.01, 'the damper (release) should stop it');
});

test('closed-loop exciters sustain while played and stop when the player does', () => {
  for (const [name, layer, root] of PAIRS.filter(([, l]) => l.exciter.kind !== 'pluck' && l.exciter.kind !== 'strike')) {
    const x = raw(recipe([layer], { root }), root, 1.2);
    const a = levelAt(x, SR, 0.5, 0.05), b = levelAt(x, SR, 1.1, 0.05);
    assert.ok(Math.abs(toDb(b / a)) < 4, `${name} doesn't hold: ${toDb(a).toFixed(1)} → ${toDb(b).toFixed(1)} dB`);
    // the ring-out ends the sound: by its last 50 ms it's 40 dB down
    const after = levelAt(x, SR, x.length / SR - 0.03, 0.05);
    assert.ok(after < b * 0.01, `${name} keeps sounding after release (${toDb(after / b).toFixed(1)} dB)`);
    assert.ok(x.length / SR < 1.2 + 0.1 + (layer.resonator.kind === 'string' ? 1.2 : 0.3), `${name} rings on too long`);
  }
});

test('a reed on a cylindrical bore favours odd harmonics', () => {
  const x = raw(recipe([model({ kind: 'reed' }, { kind: 'bore', end: 'open' })]), 55);
  const f = midiToHz(55);
  const h = (n: number) => amplitudeAt(x, SR, n * f, Math.round(0.6 * SR), 8192);
  assert.ok(h(3) > h(2) * 3 && h(5) > h(4) * 3, `2nd ${toDb(h(2)).toFixed(1)} 3rd ${toDb(h(3)).toFixed(1)} 4th ${toDb(h(4)).toFixed(1)} 5th ${toDb(h(5)).toFixed(1)}`);
});

test('where a string is plucked or bowed shapes its spectrum', () => {
  const f = midiToHz(48);
  // plucked a quarter of the way along: every 4th harmonic is missing
  const quarter = raw(recipe([model({ kind: 'pluck', position: 0.25, hardness: 1 }, { kind: 'string', decay: 3, brightness: 1 })]), 48);
  const h = (n: number) => amplitudeAt(quarter, SR, n * f, Math.round(0.05 * SR), 8192);
  assert.ok(h(4) < h(3) * 0.15 && h(4) < h(5) * 0.15, `4th ${toDb(h(4)).toFixed(1)} vs 3rd ${toDb(h(3)).toFixed(1)}, 5th ${toDb(h(5)).toFixed(1)}`);
  // bowed near the bridge is brighter than over the fingerboard
  const bowed = (position: number) => spectralCentroid(raw(recipe([model({ kind: 'bow', position }, { kind: 'string', decay: 1 })]), 48), SR, Math.round(0.6 * SR), 8192);
  assert.ok(bowed(0.06) > bowed(0.3) * 1.2, `ponticello ${bowed(0.06).toFixed(0)} Hz vs tasto ${bowed(0.3).toFixed(0)} Hz`);
});

test('a stiff string stretches its upper partials', () => {
  const x = raw(recipe([model({ kind: 'strike', hardness: 1 }, { kind: 'string', decay: 4, brightness: 1, stiffness: 0.8 })]), 36);
  const f = midiToHz(36);
  // stiffness 0.8 is B ≈ 0.001: the 6th partial sounds at 6·√(1 + 36B) ≈ 6.1·f
  const at = (hz: number) => amplitudeAt(x, SR, hz, Math.round(0.05 * SR), 16384);
  let best = 0, bestHz = 0;
  for (let hz = 5.6 * f; hz < 6.4 * f; hz += 0.5) { const a = at(hz); if (a > best) { best = a; bestHz = hz; } }
  assert.ok(bestHz > 6.05 * f && bestHz < 6.2 * f, `the 6th partial is at ${(bestHz / f).toFixed(3)}·f`);
});

test('radiators shape the sound outside the loop', () => {
  const plain = model({ kind: 'bow' }, { kind: 'string', decay: 1 });
  const bodied = { ...plain, radiators: [{ kind: 'body', preset: 'violin' } as Radiator] };
  const belled = { ...plain, radiators: [{ kind: 'bell', cutoff: 2000, mix: 1 } as Radiator] };
  const c = (l: ModelLayer) => spectralCentroid(raw(recipe([l]), 55), SR, Math.round(0.6 * SR), 8192);
  assert.notDeepEqual(raw(recipe([bodied]), 55), raw(recipe([plain]), 55));
  assert.ok(c(belled) > c(plain) * 1.3, 'a bell high-pass brightens it');
});

// --------------------------------------------------------------- bypass

test('bypassing a block leaves it out and keeps its settings', () => {
  const pluck = model({ kind: 'pluck' }, { kind: 'string', decay: 2 }, { radiators: [{ kind: 'body', preset: 'guitar' }] });
  const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  // the radiator off = the model without it
  assert.ok(same(raw(recipe([{ ...pluck, bypass: ['radiator:0'] }])), raw(recipe([{ ...pluck, radiators: [] }]))));
  // no exciter: nothing sounds
  assert.equal(peak(raw(recipe([{ ...pluck, bypass: ['exciter'] }]))), 0);
  // no resonator: just the pluck's burst, one period long, no ringing
  const burst = raw(recipe([{ ...pluck, bypass: ['resonator', 'radiator:0'] }]));
  assert.ok(levelAt(burst, SR, 0.3, 0.05) < 1e-6 && peak(burst) > 0.1, 'only a short burst should be left');

  const synth: Layer = { type: 'wave', shape: 'saw', filter: { type: 'lowpass', cutoff: 800 }, drive: 3, vibrato: { rate: 5, depth: 30 }, env: { attack: 0.3, sustain: 1 } };
  const plainSynth: Layer = { type: 'wave', shape: 'saw', env: { attack: 0.3, sustain: 1 } };
  assert.ok(same(raw(recipe([{ ...synth, bypass: ['filter:0', 'drive', 'vibrato'] }])), raw(recipe([plainSynth]))));
  assert.equal(peak(raw(recipe([{ ...synth, bypass: ['source'] }]))), 0);
  // the envelope off: full level from the start
  const gated = raw(recipe([{ ...plainSynth, bypass: ['env'] }]));
  assert.ok(levelAt(gated, SR, 0.02, 0.01) > levelAt(raw(recipe([plainSynth])), SR, 0.02, 0.01) * 5);
});

test('every exciter on every resonator renders finite, bounded, repeatable samples', () => {
  const exciters: Exciter[] = [{ kind: 'pluck' }, { kind: 'strike' }, { kind: 'bow', pressure: 1 }, { kind: 'lips', tension: 1.3 }, { kind: 'jet', noise: 1 }, { kind: 'reed', stiffness: 1 }];
  const resonators: Resonator[] = [{ kind: 'string', decay: 8, brightness: 1, stiffness: 1 }, { kind: 'bore', end: 'open' }, { kind: 'bore', end: 'stopped', loss: 0 }, { kind: 'bore', end: 'flared', loss: 1 }];
  const radiators: Radiator[] = [{ kind: 'body', preset: 'cello' }, { kind: 'helmholtz' }, { kind: 'bell' }, { kind: 'tonehole' }, { kind: 'damping', a: 0.9 }];
  for (const exciter of exciters) {
    for (const resonator of resonators) {
      const r = recipe([model(exciter, resonator, { radiators, vibrato: { rate: 6, depth: 40 }, pitch: { amount: 3, time: 0.2 } })], { length: 1 });
      for (const [note, velocity] of [[24, 1], [60, 0.2], [96, 1]]) {
        const { left } = render(r, { note, velocity, gate: 0.4, sampleRate: 22050, normalize: false });
        for (const x of left) assert.ok(Number.isFinite(x) && Math.abs(x) < 50, `${exciter.kind} on ${resonator.kind}: ${x}`);
      }
      assert.deepEqual(render(r, { gate: 0.3, sampleRate: 22050 }), render(r, { gate: 0.3, sampleRate: 22050 }));
    }
  }
});
