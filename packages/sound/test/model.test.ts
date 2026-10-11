import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, midiToHz } from '../src/index.ts';
import type { Exciter, Layer, ModelLayer, Radiator, Resonator, SoundRecipe, StringResonator, StringSet } from '../src/index.ts';
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

// In tune to 5 cents from when the note speaks: every 50 ms from 0.1 s to
// 0.9 s, once it is within 6 dB of its held level (and it speaks by 0.4 s)
test('every model plays in tune from when it speaks, an octave either side', () => {
  const notes: [string, ModelLayer, number, number][] = PAIRS.flatMap(([name, layer, root]) =>
    [root - 12, root, root + 12].map((note): [string, ModelLayer, number, number] => [name, layer, root, note]));
  notes.push(['jet on an open bore, low', PAIRS[4][1], 72, 48], ['reed on an open bore, low', PAIRS[5][1], 60, 36]);
  for (const [name, layer, root, note] of notes) {
    const x = raw(recipe([layer], { root }), note);
    const f = midiToHz(note);
    const held = levelAt(x, SR, 0.8, 0.1);
    assert.ok(levelAt(x, SR, 0.4, 0.05) > held * 0.5, `${name} at ${note} hasn't spoken by 0.4 s`);
    for (let t = 0.1; t < 0.91; t += 0.05) {
      if (levelAt(x, SR, t, 0.05) < held * 0.5) continue;
      const hz = estimatePitch(x, SR, Math.round(t * SR) - 2048, 4096, f / 1.6, f * 1.6);
      assert.ok(Math.abs(cents(hz, note)) < 5, `${name} at ${note}, ${t.toFixed(2)} s: ${cents(hz, note).toFixed(1)} cents`);
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

// ------------------------------------------------- strings at a bridge (#108)

const struck = (string: Partial<StringResonator>, strings: StringSet[]) =>
  model({ kind: 'strike' }, { kind: 'string', decay: 8, ...string }, { strings, env: { sustain: 1, release: 0.3 } });
// how fast it falls, in dB a second, between two times
const slope = (x: Float32Array, t0: number, t1: number) => (toDb(levelAt(x, SR, t1, 0.1)) - toDb(levelAt(x, SR, t0, 0.1))) / (t1 - t0);

test('strings at a bridge never gain energy from it: nothing grows once the hammer has struck', () => {
  // The loosest bridge, strings that barely lose anything, sympathetic
  // strings at the note and its fifths, octaves and fourth (unheard), and a
  // course in perfect unison: the course moves as one string, and what is
  // heard is that string, so its level is its energy
  const x = raw(recipe([struck({ decay: 1000, brightness: 1, coupling: 1 }, [
    { kind: 'unison', cents: [0, 0, 0] },
    { kind: 'sympathetic', cents: [0, 3.5, 702, 1200, 1902, -498], decay: 1000, brightness: 1, level: 0 }
  ])], { length: 6 }), 60, 6);
  const first = Math.max(...[0.02, 0.05, 0.1].map((t) => levelAt(x, SR, t, 0.02)));
  for (let t = 0.2; t < 5.9; t += 0.1) {
    const level = levelAt(x, SR, t, 0.02);
    assert.ok(Number.isFinite(level) && level <= first * 1.01, `${toDb(level / first).toFixed(2)} dB at ${t.toFixed(1)} s`);
  }
});

test('two strings a cent apart at a bridge die fast, then slowly (a piano\'s two-stage decay)', () => {
  const pair = raw(recipe([struck({}, [{ kind: 'unison', cents: [1] }])], { length: 6 }), 60, 6);
  const fast = -60 / slope(pair, 0.1, 0.9), slow = -60 / slope(pair, 3, 5.5);
  assert.ok(fast < 4 && slow > 6 && slow > 2.5 * fast, `T60 ${fast.toFixed(1)} s, then ${slow.toFixed(1)} s`);
  // moving together they move the bridge, and give it their energy; what's
  // left is their difference, which leaves it still and dies at the strings' own rate
  assert.ok(slow > 6 && slow < 10, `the aftersound's T60 is ${slow.toFixed(1)} s (the strings' 8 s)`);
  // one string, with nothing to share a bridge with, dies at one rate
  const one = raw(recipe([struck({}, [])], { length: 6 }), 60, 6);
  const early = -60 / slope(one, 0.1, 0.9), late = -60 / slope(one, 3, 5.5);
  assert.ok(late < 1.5 * early, `one string: T60 ${early.toFixed(1)} s, then ${late.toFixed(1)} s`);
});

test('strings a few cents apart at a bridge beat', () => {
  const rise = (x: Float32Array) => {
    let low = Infinity, most = 0;
    for (let t = 0.3; t < 5.5; t += 0.05) {
      const db = toDb(levelAt(x, SR, t, 0.1));
      low = Math.min(low, db);
      most = Math.max(most, db - low);
    }
    return most;
  };
  const beating = rise(raw(recipe([struck({}, [{ kind: 'unison', cents: [3] }])], { length: 6 }), 60, 6));
  const alone = rise(raw(recipe([struck({}, [])], { length: 6 }), 60, 6));
  assert.ok(beating > 6 && alone < 1, `after its lowest it comes back up ${beating.toFixed(1)} dB (one string: ${alone.toFixed(1)} dB)`);
});

test('a sympathetic string rings when tuned to the note\'s fifth, not when 50 cents off', () => {
  const after = (strings: StringSet[]) => {
    const x = raw(recipe([model({ kind: 'pluck', hardness: 0.8 }, { kind: 'string', decay: 3, coupling: 0.5 },
      { strings, env: { sustain: 1, release: 0.05 } })], { length: 4 }), 60, 1);
    // released at 1 s: the played string is damped, the sympathetic one isn't
    return levelAt(x, SR, 1.25, 0.1);
  };
  const fifth = after([{ kind: 'sympathetic', cents: [702], decay: 6 }]);
  const off = after([{ kind: 'sympathetic', cents: [752], decay: 6 }]);
  const none = after([{ kind: 'sympathetic', cents: [702], decay: 6, level: 0 }]);
  assert.ok(fifth > 1e-5 && fifth > off * 10 && fifth > none * 10, `${toDb(fifth).toFixed(1)} dB; 50 cents off ${toDb(off).toFixed(1)}; unheard ${toDb(none).toFixed(1)}`);
});

test('radiators in parallel each take the resonator\'s sound, mixed, and switch off as a branch', () => {
  const body: Radiator = { kind: 'body', preset: 'guitar' }, bell: Radiator = { kind: 'bell', cutoff: 2000, mix: 1 };
  const plucked = model({ kind: 'pluck' }, { kind: 'string', decay: 2 }, { radiators: [body] });
  const both = { ...plucked, parallel: [bell] };
  const a = raw(recipe([plucked])), b = raw(recipe([{ ...plucked, radiators: [bell] }])), mixed = raw(recipe([both]));
  let most = 0;
  for (let i = 0; i < Math.min(a.length, b.length, mixed.length); i++) most = Math.max(most, Math.abs(mixed[i] - (a[i] + b[i]) / 2));
  assert.ok(most < 1e-5 * peak(mixed), `the paths mixed: ${most}`);
  assert.notDeepEqual(mixed, raw(recipe([{ ...plucked, radiators: [body, bell] }])));  // not the bell after the body
  // switched off, the branch is gone
  const same = (x: Float32Array, y: Float32Array) => x.length === y.length && x.every((v, i) => v === y[i]);
  assert.ok(same(raw(recipe([{ ...both, bypass: ['parallel:0'] }])), a));
});

test('a buzzing bridge fills in the harmonics a pluck leaves out, and stays in tune', () => {
  const f = midiToHz(50);
  const sitar = (buzz: number) => raw(recipe([model({ kind: 'pluck', position: 0.2, hardness: 0.8 }, { kind: 'string', decay: 4, brightness: 0.6, buzz })], { root: 50, length: 3 }), 50, 3);
  for (const t of [0.1, 0.8]) {
    // plucked a fifth of the way along: no 5th harmonic, unless the bridge buzzes
    const gap = (x: Float32Array) => toDb(amplitudeAt(x, SR, 5 * f, Math.round(t * SR), 8192) / amplitudeAt(x, SR, 4 * f, Math.round(t * SR), 8192));
    const plain = gap(sitar(0)), buzzing = gap(sitar(0.5));
    assert.ok(plain < -15 && buzzing > plain + 10, `at ${t} s the 5th harmonic is ${plain.toFixed(1)} dB under the 4th, ${buzzing.toFixed(1)} buzzing`);
  }
  const x = sitar(0.5);
  const hz = estimatePitch(x, SR, Math.round(0.5 * SR), 4096, f / 1.6, f * 1.6);
  assert.ok(Math.abs(cents(hz, 50)) < 5, `${cents(hz, 50).toFixed(1)} cents`);
});

test('strings at a bridge, under every exciter, render finite, bounded, repeatable samples', () => {
  const exciters: Exciter[] = [{ kind: 'pluck' }, { kind: 'strike' }, { kind: 'bow', pressure: 1 }, { kind: 'lips', tension: 1.3 }, { kind: 'jet', noise: 1 }, { kind: 'reed', stiffness: 1 }];
  for (const exciter of exciters) {
    const r = recipe([model(exciter, { kind: 'string', decay: 8, brightness: 1, stiffness: 1, coupling: 1, buzz: 1 }, {
      strings: [{ kind: 'unison', cents: [-3, 4] }, { kind: 'sympathetic', cents: [0, 700, 1200], decay: 10, brightness: 1, level: 4 }, { kind: 'sympathetic', notes: [30, 100] }],
      radiators: [{ kind: 'helmholtz' }], parallel: [{ kind: 'bell' }, { kind: 'body', preset: 'cello' }],
      vibrato: { rate: 6, depth: 40 }, pitch: { amount: 3, time: 0.2 }
    })], { length: 1 });
    for (const [note, velocity] of [[24, 1], [60, 0.2], [96, 1]]) {
      const { left } = render(r, { note, velocity, gate: 0.4, sampleRate: 22050, normalize: false });
      for (const x of left) assert.ok(Number.isFinite(x) && Math.abs(x) < 50, `${exciter.kind} at ${note}: ${x}`);
    }
    assert.deepEqual(render(r, { gate: 0.3, sampleRate: 22050 }), render(r, { gate: 0.3, sampleRate: 22050 }));
  }
});
