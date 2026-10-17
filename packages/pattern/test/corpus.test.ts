import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCycle, parseProgram, PatternError, hashNumbers } from '../src/index.ts';
import { CORPUS } from './corpus.ts';

// A melodic event's sound is its s (the triangle when it has none, as the
// DAW plays it); a drum's is its name
const soundOf = (value: Record<string, unknown>) => (value.note !== undefined ? (value.s as string | undefined) ?? 'triangle' : value.s as string);

test('the corpus has at least 20 realistic programs, and each parses', () => {
  assert.ok(CORPUS.length >= 20, `${CORPUS.length} programs`);
  for (const entry of CORPUS) assert.ok(parseProgram(entry.code).statements.length >= 1, entry.ask);
});

for (const entry of CORPUS) {
  test(`corpus: ${entry.ask}`, () => {
    const { cps, setsTempo, events } = evaluateCycle(entry.code);
    if (entry.bpm) {
      assert.ok(setsTempo, 'sets a tempo');
      assert.equal(Math.round(cps * 240 * 100) / 100, entry.bpm, 'the tempo in BPM');
    } else assert.equal(setsTempo, false);
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[soundOf(e.value)] = (counts[soundOf(e.value)] ?? 0) + 1;
      assert.ok(e.time >= 0 && e.time < 1 && e.duration > 0, `${JSON.stringify(e)} within the cycle`);
    }
    assert.deepEqual(counts, entry.sounds);
    // notes are names or numbers the DAW can read
    for (const e of events) {
      if (e.value.note !== undefined) assert.ok(typeof e.value.note === 'number' || /^[a-gA-G][#sb]*-?\d*$/.test(String(e.value.note)), `note ${e.value.note}`);
    }
    // deterministic
    assert.deepEqual(evaluateCycle(entry.code), { cps, setsTempo, events });
  });
}

// The program fuzz test: the corpus mutated and reassembled only ever gives
// events or a PatternError, within the limits, fast, always the same way
class Rng {
  private state: number;
  constructor(seed: number) { this.state = hashNumbers(seed, 0xc0de); }
  next(): number { this.state = hashNumbers(this.state, 3); return this.state / 2 ** 32; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(xs: T[]): T { return xs[this.int(xs.length)]; }
}

const PIECES = ['(', ')', '[', ']', ',', '.', '"', "'", '`', ' ', '\n', '=>', '$:', ';', '+', '-', '*', '/', '0', '2', '12', '0.5', 'x', '~', '<', '>', '{', '}', '%', '!', '@', '?', ':', '|',
  'fast', 'slow', 'rev', 'every', 'stack', 'note', 's', 'n', 'scale', 'gain', 'bank', 'off', 'ply', 'struct', 'euclid', 'sometimes', 'degradeBy', 'setcpm', 'add', 'transpose', 'sine', 'rand',
  '"bd*4"', '"c3 e3"', '"C:major"', '"<0 2>"', 'x => x.fast(2)', '.s("piano")', '.gain(0.5)', '.every(2, rev)', 'foo', 'eval', 'Function', 'window', 'process', 'require', 'import', 'this', '__proto__', 'constructor', 'prototype'];

function mutate(r: Rng, code: string): string {
  const chars = [...code];
  for (let i = 0, n = 1 + r.int(4); i < n; i++) {
    const at = r.int(chars.length + 1);
    switch (r.int(4)) {
      case 0: chars.splice(at, 1 + r.int(3)); break;
      case 1: chars.splice(at, 0, r.pick(PIECES)); break;
      case 2: chars.splice(at, 1, r.pick(PIECES)); break;
      default: { const [from, to] = [r.int(chars.length), r.int(chars.length)]; const piece = chars.slice(Math.min(from, to), Math.max(from, to) + 1); chars.splice(at, 0, ...piece); }
    }
  }
  return chars.join('');
}

function assembled(r: Rng): string {
  return Array.from({ length: 1 + r.int(12) }, () => r.pick(PIECES)).join(r.pick(['', ' ', '']));
}

const LIMITS = { maxEvents: 5000, maxMillis: 500 };

function outcome(code: string): string {
  const started = performance.now();
  try {
    const { events } = evaluateCycle(code, LIMITS);
    assert.ok(events.length <= LIMITS.maxEvents, `${code}: ${events.length} events`);
    for (const e of events) assert.ok(typeof e.time === 'number' && e.time >= 0 && e.time < 1 && typeof e.value === 'object', `${code}: ${JSON.stringify(e)}`);
    return `events ${JSON.stringify(events)}`;
  } catch (e) {
    if (e instanceof PatternError) return `error ${e.message}`;
    throw new Error(`${JSON.stringify(code)} threw something else: ${(e as Error).stack}`);
  } finally {
    assert.ok(performance.now() - started < 3000, `${JSON.stringify(code)} took ${(performance.now() - started).toFixed(0)} ms`);
  }
}

test('mutated corpus programs only ever give events or a PatternError, always the same way', () => {
  let errors = 0, fine = 0;
  for (let seed = 0; seed < 1500; seed++) {
    const r = new Rng(seed);
    const code = mutate(r, r.pick(CORPUS).code);
    const result = outcome(code);
    assert.equal(outcome(code), result, `${JSON.stringify(code)} is not deterministic`);
    if (result.startsWith('error')) errors++; else fine++;
  }
  assert.ok(errors > 100 && fine > 100, `${errors} errors, ${fine} fine`);
});

test('programs assembled from pieces only ever give events or a PatternError', () => {
  for (let seed = 0; seed < 1500; seed++) outcome(assembled(new Rng(seed + 5000)));
});

test('nothing in a program reaches JavaScript', () => {
  for (const code of [
    'eval("1")', 'Function("return 1")()', 'this.constructor', 'constructor.constructor("return process")()', 's("bd").constructor', 's("bd").__proto__',
    's("bd").queryArc(0, 1)', 's("bd").fmap(x => x)', 'globalThis', 'window', 'process.exit()', 'require("fs")', 'import("fs")', 'new Date()', 'Object.keys(s)',
    'x => x.constructor.constructor("return 1")()', 's("bd").every(2, x => x.constructor)', 'stack.call', 'note.apply(null, [])', 'setcpm.toString()', '`${process}`'
  ]) {
    assert.throws(() => evaluateCycle(code), PatternError, code);
  }
});
