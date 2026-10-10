// Every sound in the library is checked by measurement: nothing here can
// listen, so each sound must at least render cleanly, sit at the library's
// loudness, end on its own, and have the character its kind should.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.ts';
import type { ModelLayer, SoundRecipe } from '../src/index.ts';
import { CATEGORY_NAMES, GM_DRUM_NAMES, KITS, LIBRARY, findSound } from '../src/library/index.ts';
import { bandShare, levelAt, loudness, mean, peak, periodicity, spectralCentroid, toDb } from '../src/analysis.ts';
import { midiToHz } from '../src/dsp.ts';

const SR = 44100;
// Each as normalization measures it: the root note, held for the recipe's length
const rendered = new Map(LIBRARY.map((r) => [r.id, render(r, { sampleRate: SR })]));
const tagged = (tag: string) => LIBRARY.filter((r) => r.tags?.includes(tag));

test('every sound has a unique id, a name and a known category', () => {
  const ids = new Set<string>();
  for (const r of LIBRARY) {
    assert.match(r.id, /^[a-z0-9-]+$/, r.id);
    assert.ok(!ids.has(r.id), `${r.id} is used twice`);
    ids.add(r.id);
    assert.ok(r.name.trim(), `${r.id} has no name`);
    assert.ok(r.category in CATEGORY_NAMES, `${r.id}: unknown category ${r.category}`);
    assert.ok(r.layers.length > 0, `${r.id} has no layers`);
  }
});

test('every sound renders clean samples at the library loudness', () => {
  for (const r of LIBRARY) {
    const { left, right } = rendered.get(r.id)!;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${r.id} has a non-finite sample at ${i}`);
    }
    const top = Math.max(peak(left), peak(right));
    const lufs = loudness(left, right, SR);
    assert.ok(toDb(top) <= -0.99, `${r.id} peaks at ${toDb(top).toFixed(2)} dBFS`);
    assert.ok(lufs <= -11.9, `${r.id} is too loud: ${lufs.toFixed(1)} LUFS`);
    // Either it reaches the loudness target, or its peak stopped it short
    assert.ok(lufs > -12.1 || toDb(top) > -1.01, `${r.id} is quiet (${lufs.toFixed(1)} LUFS) with headroom left`);
    assert.ok(Math.abs(mean(left)) < 0.01 * top && Math.abs(mean(right)) < 0.01 * top, `${r.id} has a DC offset`);
  }
});

test('one-shots end on their own before their length cuts them off', () => {
  for (const r of LIBRARY.filter((s) => !s.pitched)) {
    const { left } = rendered.get(r.id)!;
    assert.ok(left.length < Math.ceil(r.length * SR), `${r.id} is still sounding at ${r.length} s`);
  }
});

test('softer hits are quieter', () => {
  for (const r of LIBRARY) {
    const soft = render(r, { sampleRate: SR, velocity: 0.4 });
    const full = rendered.get(r.id)!;
    assert.ok(peak(soft.left) < peak(full.left) * 0.5, `${r.id} barely changes with velocity`);
  }
});

// A pitched sound plays the note asked for: it repeats once per period of
// the note, and not twice per period (which would be an octave up). Bells
// and other inharmonic sounds don't repeat, and are left out.
test('pitched sounds play the note asked for, an octave either side of their root', () => {
  for (const r of LIBRARY.filter((s) => s.pitched && !s.tags?.includes('inharmonic'))) {
    const root = r.root ?? 60;
    for (const note of [root - 12, root, root + 12]) {
      const { left } = render(r, { sampleRate: SR, note, gate: 0.6 });
      const at = Math.round(0.3 * SR);
      const hz = midiToHz(note);
      const once = periodicity(left, SR, hz, at, 4096);
      const twice = periodicity(left, SR, hz * 2, at, 4096);
      assert.ok(once < 0.15, `${r.id} at ${note} doesn't repeat at ${hz.toFixed(1)} Hz (${once.toFixed(3)})`);
      // (a resonance on the 2nd harmonic brings this down, but never near 0)
      assert.ok(twice > 0.08, `${r.id} at ${note} sounds an octave up (${twice.toFixed(3)})`);
    }
  }
});

test('pitched sounds stay clean across the keyboard', () => {
  for (const r of LIBRARY.filter((s) => s.pitched)) {
    const root = r.root ?? 60;
    for (const note of [Math.max(21, root - 24), Math.min(108, root + 24)]) {
      const { left, right } = render(r, { sampleRate: SR, note, gate: 0.5 });
      const top = Math.max(peak(left), peak(right));
      assert.ok(top < 1, `${r.id} clips at note ${note} (${toDb(top).toFixed(1)} dBFS)`);
      for (let i = 0; i < left.length; i++) assert.ok(Number.isFinite(left[i]), `${r.id} at ${note}: sample ${i}`);
    }
  }
});

// ------------------------------------------------------------ modeled (#79)

const modeled = tagged('modeled');

test('modeled instruments are physical models, the bowed and blown ones in a closed loop', () => {
  assert.ok(modeled.length >= 16, `${modeled.length} modeled sounds`);
  for (const r of modeled) {
    assert.ok(r.layers.every((l) => l.type === 'model'), `${r.id} isn't all model layers`);
    const kinds = r.layers.map((l) => l.type === 'model' && l.exciter.kind);
    assert.ok(kinds.every((k) => k === kinds[0]));
  }
});

test('bowed and blown instruments sustain while played and stop when the player does', () => {
  for (const r of modeled.filter((s) => s.layers[0].type === 'model' && !['pluck', 'strike'].includes(s.layers[0].exciter.kind))) {
    const { left } = render(r, { sampleRate: SR, gate: 2.5 });
    const a = levelAt(left, SR, 1, 0.1), b = levelAt(left, SR, 2.3, 0.1);
    assert.ok(Math.abs(toDb(b / a)) < 3, `${r.id} doesn't hold: ${toDb(a).toFixed(1)} → ${toDb(b).toFixed(1)} dB`);
    // a string rings on for its decay when the bow leaves it; air stops at once
    const l = r.layers[0] as ModelLayer;
    const ring = l.resonator.kind === 'string' ? l.resonator.decay ?? 3 : 0.25;
    const release = l.env?.release ?? 0.05;
    const t = 2.5 + release + ring * 0.75;
    const after = t * SR < left.length ? levelAt(left, SR, t, 0.05) : 0;
    assert.ok(after < b * 0.01, `${r.id} keeps sounding after release (${toDb(after / b).toFixed(1)} dB at ${t.toFixed(2)} s)`);
    // and it has died away by its end, not been cut off
    const end = levelAt(left, SR, left.length / SR - 0.03, 0.05);
    assert.ok(end < b * 0.01, `${r.id} is cut off ${toDb(end / b).toFixed(1)} dB down`);
    assert.ok(left.length / SR <= 2.5 + release + ring + 0.05, `${r.id} rings on ${(left.length / SR - 2.5).toFixed(2)} s after release`);
  }
});

test('plucked and struck instruments ring down on their own, and stop on release', () => {
  for (const r of modeled.filter((s) => s.layers[0].type === 'model' && ['pluck', 'strike'].includes(s.layers[0].exciter.kind))) {
    const { left } = render(r, { sampleRate: SR, gate: 3 });
    assert.ok(levelAt(left, SR, 1, 0.05) < levelAt(left, SR, 0.1, 0.05) * 0.7, `${r.id} doesn't ring down`);
    const held = render(r, { sampleRate: SR, gate: 0.3 }).left;
    // 40 dB down, or gone (-70 dBFS) if it had all but died away already
    const end = levelAt(held, SR, held.length / SR - 0.03, 0.05);
    assert.ok(end < Math.max(levelAt(held, SR, 0.25, 0.05) * 0.01, 3e-4), `${r.id} isn't damped on release (${toDb(end).toFixed(1)} dB)`);
  }
});

// ------------------------------------------------------------ by character

const centroid = (r: SoundRecipe) => spectralCentroid(rendered.get(r.id)!.left, SR, 0, 4096);
const lowShare = (r: SoundRecipe) => bandShare(rendered.get(r.id)!.left, SR, 20, 250, 0, 8192);

test('kicks are low', () => {
  for (const r of tagged('kick')) {
    assert.ok(lowShare(r) > 0.9, `${r.id}: only ${(lowShare(r) * 100).toFixed(0)}% below 250 Hz`);
  }
});

test('snares have both a body and wires', () => {
  for (const r of tagged('snare')) {
    const { left } = rendered.get(r.id)!;
    assert.ok(bandShare(left, SR, 1500, 20000, 0, 8192) > 0.2, `${r.id} has no wires`);
    assert.ok(centroid(r) > 1000 && centroid(r) < 6000, `${r.id} centres at ${centroid(r).toFixed(0)} Hz`);
  }
});

test('hats and crashes are bright', () => {
  for (const r of tagged('hat')) assert.ok(centroid(r) > 8000, `${r.id} centres at ${centroid(r).toFixed(0)} Hz`);
  for (const r of [...tagged('crash'), ...tagged('splash'), ...tagged('china')]) {
    assert.ok(centroid(r) > 5000, `${r.id} centres at ${centroid(r).toFixed(0)} Hz`);
  }
});

test('toms rise from low to high', () => {
  const [low, mid, high] = ['tom-low', 'tom-mid', 'tom-high'].map((id) => centroid(findSound(id)!));
  assert.ok(low < mid && mid < high, `${low} ${mid} ${high}`);
});

// -------------------------------------------------------------------- kits

test('every kit covers the General MIDI drum notes with library sounds', () => {
  const names = new Set<string>();
  for (const kit of KITS) {
    assert.ok(!names.has(kit.name), `two kits are called ${kit.name}`);
    names.add(kit.name);
    for (const note of Object.keys(GM_DRUM_NAMES).map(Number)) {
      const pad = kit.pads[note];
      assert.ok(pad, `${kit.name} has nothing on ${note} (${GM_DRUM_NAMES[note]})`);
      assert.ok(findSound(pad.sound), `${kit.name} ${note}: no sound ${pad.sound}`);
    }
    for (const group of kit.chokes ?? []) for (const note of group) assert.ok(kit.pads[note], `${kit.name} chokes an empty pad ${note}`);
  }
});
