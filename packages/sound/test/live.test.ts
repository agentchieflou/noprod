// Live notes (#106): a note of a sound played for as long as the key is
// held, following the player, ringing out when let go

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveNote, liveTunings, playsLive, legato, render, midiToHz } from '../src/index.ts';
import type { SoundRecipe } from '../src/index.ts';
import { findSound, LIBRARY } from '../src/library/index.ts';
import { estimatePitch, levelAt, toDb } from '../src/analysis.ts';

const SR = 44100;

// Plays a live note in 128-sample blocks, let go at `release` (seconds, or
// never), for at most `seconds`
function play(recipe: SoundRecipe, note: number, velocity: number, release: number, seconds: number, during?: (live: LiveNote, t: number) => void) {
  const live = new LiveNote(recipe, { note, velocity, sampleRate: SR, tunings: liveTunings(recipe, note, velocity, SR) });
  const n = Math.round(seconds * SR), gate = Math.round(release * SR);
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let k = 0; k < n && !live.done;) {
    const to = Math.min(n, k + 128, k < gate ? gate : Infinity);
    during?.(live, k / SR);
    live.process(left, right, k, to);
    if (to === gate) live.release();
    k = to;
  }
  return { left, right, live };
}

test('the sounds that play live: pitched, of physical models; blown ones slur', () => {
  assert.ok(playsLive(findSound('violin')!) && playsLive(findSound('sitar')!));
  assert.ok(!playsLive(findSound('piano-grand')!), 'a spectral sound renders');
  assert.ok(legato(findSound('trumpet-modeled')!) && legato(findSound('flute-modeled')!) && legato(findSound('clarinet-modeled')!));
  assert.ok(!legato(findSound('violin')!) && !legato(findSound('guitar-nylon-modeled')!));
  assert.ok(!legato({ ...findSound('clarinet-modeled')!, legato: false }));
});

test('a live note let go where a rendered note\'s gate is plays that note, to the bit', () => {
  const two: SoundRecipe = {
    id: 'two', name: 'Two', category: 'strings', pitched: true, root: 57, length: 2, layers: [
      { type: 'model', exciter: { kind: 'bow' }, resonator: { kind: 'string', decay: 2 }, radiators: [{ kind: 'body', preset: 'violin' }],
        vibrato: { rate: 5, depth: 20, delay: 0.1 }, tremolo: { rate: 4, depth: 0.3 }, filter: { type: 'lowpass', cutoff: 3000, env: { attack: 0.05, sustain: 0.5, amount: 1 } },
        drive: 1, pan: -0.4, env: { attack: 0.1, sustain: 1, release: 0.2 } },
      { type: 'model', exciter: { kind: 'pluck' }, resonator: { kind: 'string', decay: 1, stiffness: 0.3 }, ratio: 2, start: 0.05, level: 0.5, pan: 0.5,
        pitch: { amount: -2, time: 0.05 }, env: { sustain: 1, release: 0.1 } }
    ]
  };
  const sounds = [...LIBRARY.filter((r) => r.tags?.includes('modeled')), two];
  for (const recipe of sounds) {
    const note = (recipe.root ?? 60) + 2;
    const rendered = render(recipe, { note, velocity: 0.7, gate: 0.6, sampleRate: SR, normalize: false });
    const { left, right } = play(recipe, note, 0.7, 0.6, rendered.left.length / SR + 1);
    // (a render cut off by its length fades out over its last 5 ms)
    const n = rendered.left.length - 256;
    for (let i = 0; i < n; i++) {
      if (left[i] !== rendered.left[i] || right[i] !== rendered.right[i]) assert.fail(`${recipe.id} differs at sample ${i}: ${left[i]} vs ${rendered.left[i]}`);
    }
  }
});

test('a live violin sounds for as long as the key is held, then rings out and ends', () => {
  const violin = findSound('violin')!;
  const held = play(violin, 67, 0.8, Infinity, 10);
  const at2 = levelAt(held.left, SR, 2, 0.2), at9 = levelAt(held.left, SR, 9.5, 0.2);
  assert.ok(at9 > 0.01 && Math.abs(toDb(at9 / at2)) < 3, `held: ${toDb(at2).toFixed(1)} dB at 2 s, ${toDb(at9).toFixed(1)} dB at 9.5 s`);
  assert.ok(!held.live.done);
  // let go at 6 s: it rings out over its release and tail, then ends
  const let6 = play(violin, 67, 0.8, 6, 9);
  assert.ok(let6.live.done, 'it ends');
  assert.ok(levelAt(let6.left, SR, 5.9, 0.1) > 0.01, 'still sounding just before it was let go');
  assert.ok(levelAt(let6.left, SR, 6.5, 0.05) < levelAt(let6.left, SR, 5.9, 0.1) * 0.01, 'rung out half a second later');
});

test('a slur moves the same voice to the next note, without a new attack', () => {
  const flute = findSound('flute-modeled')!;
  const { left } = play(flute, 72, 0.8, Infinity, 1.6, (live, t) => { if (t >= 0.8) live.slur(76); });
  const before = estimatePitch(left, SR, Math.round(0.6 * SR), 4096, 300, 900);
  const after = estimatePitch(left, SR, Math.round(1.3 * SR), 4096, 300, 900);
  const cents = (hz: number, note: number) => 1200 * Math.log2(hz / midiToHz(note));
  assert.ok(Math.abs(cents(before, 72)) < 10 && Math.abs(cents(after, 76)) < 10, `${cents(before, 72).toFixed(1)} then ${cents(after, 76).toFixed(1)} cents`);
  // no dip, no new attack: the level through the slur stays within 6 dB
  const levels = [0.7, 0.78, 0.82, 0.86, 0.9, 1.0].map((t) => toDb(levelAt(left, SR, t, 0.02)));
  assert.ok(Math.max(...levels) - Math.min(...levels) < 6, levels.map((x) => x.toFixed(1)).join(' '));
});
