import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, chainOf, setBlockOn, setKindOn, addBlock, removeBlock, branchesFor, sharedBlocks, BLOCKS, STAGES, LIBRARY } from '../src/index.ts';
import type { Layer, ModelLayer, SoundRecipe } from '../src/index.ts';

const SR = 22050;
const samples = (r: SoundRecipe) => render(r, { sampleRate: SR, gate: 0.4, normalize: false }).left;
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const recipe = (id: string, layers: Layer[], extra: Partial<SoundRecipe> = {}): SoundRecipe =>
  ({ id, name: id, category: 'strings', pitched: true, root: 60, length: 0.8, layers, ...extra });

const violin = recipe('violin', [{
  type: 'model', exciter: { kind: 'bow' }, resonator: { kind: 'string', decay: 1 },
  radiators: [{ kind: 'body', preset: 'violin' }], vibrato: { rate: 5.5, depth: 15 }, env: { attack: 0.08, sustain: 1, release: 0.2 }
}]);
const guitar = recipe('guitar', [{
  type: 'model', exciter: { kind: 'pluck' }, resonator: { kind: 'string', decay: 3 },
  radiators: [{ kind: 'body', preset: 'guitar' }, { kind: 'helmholtz', hz: 100 }], env: { sustain: 1, release: 0.3 }
}], { category: 'plucks' });
const lead = recipe('lead', [
  { type: 'wave', shape: 'saw', unison: { voices: 3, detune: 12 }, filter: { type: 'lowpass', cutoff: 2400, q: 1.5 }, vibrato: { rate: 5, depth: 10 }, drive: 1.5, env: { attack: 0.01, sustain: 0.8, release: 0.2 } },
  { type: 'noise', level: 0.05, filter: { type: 'highpass', cutoff: 4000 }, env: { sustain: 1, release: 0.1 } }
], { category: 'leads' });

test('every library sound describes as a chain of known blocks', () => {
  const stages = new Set(STAGES.map((s) => s.id));
  for (const r of LIBRARY) {
    const chain = chainOf(r);
    assert.equal(chain.layers.length, r.layers.length);
    for (const lc of chain.layers) {
      const ids = lc.blocks.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length, `${r.id}: duplicate block ids ${ids}`);
      for (const b of lc.blocks) {
        assert.ok(BLOCKS[b.kind], `${r.id}: unknown kind ${b.kind}`);
        assert.ok(stages.has(b.stage) && b.stage === BLOCKS[b.kind].stage);
      }
      // the stages come in order, and every layer has an envelope, a source or exciter, and a mix
      const order = lc.blocks.map((b) => STAGES.findIndex((s) => s.id === b.stage));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${r.id} layer ${lc.index} is out of order`);
      assert.ok(['env', 'mix'].every((id) => ids.includes(id)) && (ids.includes('source') || ids.includes('exciter')));
      // any bypass the recipe has names one of its blocks
      for (const id of r.layers[lc.index].bypass ?? []) assert.ok(ids.includes(id), `${r.id}: bypass ${id} names no block`);
    }
  }
});

test('a model describes its stages, and a closed loop marks its exciter and resonator', () => {
  const [v] = chainOf(violin).layers;
  assert.deepEqual(v.blocks.map((b) => `${b.stage}:${b.kind}`),
    ['input:env', 'input:vibrato', 'excitation:bow', 'resonator:string', 'radiator:body', 'output:mix']);
  assert.ok(v.closed && v.blocks.filter((b) => b.loop).map((b) => b.id).join() === 'exciter,resonator');
  assert.equal(chainOf(guitar).layers[0].closed, false);
  assert.equal(v.blocks.find((b) => b.kind === 'body')!.detail, 'violin');
});

test('switching a block off changes the sound, and back on restores it exactly', () => {
  for (const r of [violin, guitar, lead]) {
    const before = samples(r);
    for (const lc of chainOf(r).layers) {
      for (const b of lc.blocks.filter((x) => x.switchable)) {
        const off = setBlockOn(r, lc.index, b.id, false);
        assert.ok(!chainOf(off).layers[lc.index].blocks.find((x) => x.id === b.id)!.on);
        assert.ok(!same(samples(off), before), `${r.id}: switching ${b.id} off changed nothing`);
        const on = setBlockOn(off, lc.index, b.id, true);
        assert.deepEqual(on, r, `${r.id}: ${b.id} back on isn't the same recipe`);
        assert.ok(same(samples(on), before));
      }
    }
  }
  assert.throws(() => setBlockOn(lead, 0, 'mix', false));
  assert.throws(() => setBlockOn(lead, 0, 'radiator:0', false));
});

test('branches add blocks that change the sound; exciters and resonators swap', () => {
  const plain = samples(violin);
  // a bell on a violin
  assert.ok(branchesFor(violin, 0, 'radiator').includes('bell'));
  const belled = addBlock(violin, 0, 'bell');
  assert.deepEqual((belled.layers[0] as ModelLayer).radiators!.map((r) => r.kind), ['body', 'bell']);
  assert.ok(!same(samples(belled), plain));
  // a guitar's string bowed: the pluck is replaced
  assert.ok(branchesFor(guitar, 0, 'excitation').includes('bow') && !branchesFor(guitar, 0, 'excitation').includes('pluck'));
  const bowed = addBlock(guitar, 0, 'bow');
  assert.equal((bowed.layers[0] as ModelLayer).exciter.kind, 'bow');
  assert.ok(chainOf(bowed).layers[0].closed);
  // a filter in series, on any layer
  const filtered = addBlock(violin, 0, 'lowpass');
  assert.equal(chainOf(filtered).layers[0].blocks.find((b) => b.id === 'filter:0')!.kind, 'lowpass');
  assert.ok(!same(samples(filtered), plain));
  // a spectral source is a parallel branch: a new layer
  const breathy = addBlock(violin, 0, 'noise');
  assert.equal(breathy.layers.length, 2);
  assert.equal(breathy.layers[1].type, 'noise');
  assert.ok(!same(samples(breathy), plain));
  // radiators belong to models
  assert.ok(!branchesFor(lead, 0).includes('body'));
  assert.throws(() => addBlock(lead, 0, 'body'));
  // the original is untouched
  assert.equal((violin.layers[0] as ModelLayer).radiators!.length, 1);
});

test('removing a block renumbers the ones after it, bypasses included', () => {
  let g = setBlockOn(guitar, 0, 'radiator:1', false);
  g = removeBlock(g, 0, 'radiator:0');
  const l = g.layers[0] as ModelLayer;
  assert.deepEqual(l.radiators!.map((r) => r.kind), ['helmholtz']);
  assert.deepEqual(l.bypass, ['radiator:0']);
  assert.equal(chainOf(g).layers[0].blocks.find((b) => b.kind === 'helmholtz')!.on, false);
  // the vibrato goes, its bypass with it
  const v = removeBlock(setBlockOn(violin, 0, 'vibrato', false), 0, 'vibrato');
  assert.equal(v.layers[0].vibrato, undefined);
  assert.equal(v.layers[0].bypass, undefined);
  // filters: the list collapses back to one
  const two = addBlock(addBlock(violin, 0, 'lowpass'), 0, 'highpass');
  assert.equal((removeBlock(two, 0, 'filter:0').layers[0].filter as { type: string }).type, 'highpass');
  for (const id of ['exciter', 'resonator', 'env', 'mix']) assert.throws(() => removeBlock(violin, 0, id));
});

test('shared blocks across a violin, a guitar and a synth lead', () => {
  const shared = sharedBlocks([violin, guitar, lead]);
  const of = (kind: string) => shared.find((s) => s.kind === kind)?.chains;
  assert.deepEqual(of('string'), [0, 1]);   // both strings
  assert.deepEqual(of('body'), [0, 1]);     // both have bodies (different ones)
  assert.deepEqual(of('vibrato'), [0, 2]);  // the violin and the lead
  assert.deepEqual(of('env'), [0, 1, 2]);   // every instrument is played
  assert.equal(of('bow'), undefined);       // only the violin is bowed
  assert.equal(of('mix'), undefined);
  // in stage order
  const order = shared.map((s) => STAGES.findIndex((x) => x.id === s.stage));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // the common chain toggle: vibrato off everywhere, and the sharing shows it
  const off = [violin, guitar, lead].map((r) => setKindOn(r, 'vibrato', false));
  assert.deepEqual(sharedBlocks(off).find((s) => s.kind === 'vibrato')!.on, [false, false]);
  assert.deepEqual(off[1], guitar);  // nothing to switch on the guitar
  assert.ok(!same(samples(off[0]), samples(violin)));
});
