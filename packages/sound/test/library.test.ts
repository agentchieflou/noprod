// Every sound in the library is checked by measurement: nothing here can
// listen, so each sound must at least render cleanly, sit at the library's
// loudness, end on its own, and have the character its kind should.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.ts';
import type { SoundRecipe } from '../src/index.ts';
import { CATEGORY_NAMES, GM_DRUM_NAMES, KITS, LIBRARY, findSound } from '../src/library/index.ts';
import { bandShare, loudness, mean, peak, spectralCentroid, toDb } from '../src/analysis.ts';

const SR = 44100;
const rendered = new Map(LIBRARY.map((r) => [r.id, render(r, { sampleRate: SR, gate: r.pitched ? 1 : undefined })]));
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
    const soft = render(r, { sampleRate: SR, velocity: 0.4, gate: r.pitched ? 1 : undefined });
    const full = rendered.get(r.id)!;
    assert.ok(peak(soft.left) < peak(full.left) * 0.5, `${r.id} barely changes with velocity`);
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
