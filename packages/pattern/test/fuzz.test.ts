import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mini, PatternError, hashNumbers, MINI_LIMITS } from '../src/index.ts';

// Random and mutated mini-notation strings only ever give events or a
// PatternError, within the limits, and always the same way
class Rng {
  private state: number;
  constructor(seed: number) { this.state = hashNumbers(seed, 0xf022); }
  next(): number { this.state = hashNumbers(this.state, 7); return this.state / 2 ** 32; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(xs: T[]): T { return xs[this.int(xs.length)]; }
}

const ATOMS = ['a', 'bd', 'sd:3', 'c3', 'eb4', 'c#3', '~', '0', '1', '-1', '0.5', '3', '8', 't', 'f', 'hh'];
const GLYPHS = [' ', ' ', ' ', '[', ']', '<', '>', '{', '}', '(', ')', ',', '|', '*', '/', '!', '@', '?', '%', '.', '..', '_', ':', '-', '#', '\n'];

function grammatical(r: Rng, depth = 0): string {
  const atom = () => r.pick(ATOMS);
  if (depth > 4 || r.next() < 0.3) return atom();
  const sub = () => grammatical(r, depth + 1);
  const many = (sep: string) => Array.from({ length: 1 + r.int(4) }, sub).join(sep);
  switch (r.int(12)) {
    case 0: return many(' ');
    case 1: return `[${many(' ')}]`;
    case 2: return `<${many(' ')}>`;
    case 3: return `[${many(', ')}]`;
    case 4: return `[${many(' | ')}]`;
    case 5: return `{${many(', ')}}${r.next() < 0.5 ? `%${1 + r.int(8)}` : ''}`;
    case 6: return `${sub()}${r.pick(['*', '/'])}${r.pick(['2', '3', '1.5', '0', '<2 3>', '[1 2]'])}`;
    case 7: return `${sub()}${r.pick(['!2', '!3', '!', '@2', '@3', '@0.5', '?', '?0.3', '?0.9'])}`;
    case 8: return `${sub()}(${r.pick(['3', '5', '<3 5>', '-3'])},${r.pick(['8', '16', '5'])}${r.next() < 0.5 ? `,${r.int(5) - 2}` : ''})`;
    case 9: return `${r.int(8)} .. ${r.int(8)}`;
    case 10: return `${sub()} . ${sub()}`;
    default: return `${sub()} _ ${sub()}`;
  }
}

function mutate(r: Rng, s: string): string {
  const chars = [...s];
  for (let i = 0, n = 1 + r.int(3); i < n; i++) {
    const at = r.int(chars.length + 1);
    switch (r.int(3)) {
      case 0: chars.splice(at, 1); break;
      case 1: chars.splice(at, 0, r.pick(GLYPHS)); break;
      default: chars.splice(at, 1, r.pick([...GLYPHS, ...ATOMS])); break;
    }
  }
  return chars.join('');
}

function random(r: Rng): string {
  return Array.from({ length: 1 + r.int(24) }, () => (r.next() < 0.5 ? r.pick(ATOMS) : r.pick(GLYPHS))).join('');
}

const LIMITS = { maxEvents: 5000, maxMillis: 500 };

// Events, or the PatternError the string deserves; anything else is a bug
function outcome(src: string): string {
  try {
    const haps = mini(src).queryArc(0, 2, LIMITS);
    assert.ok(haps.length <= LIMITS.maxEvents);
    for (const h of haps) assert.ok(h.part.begin.gte(0) && h.part.end.lte(2), `${src}: ${h} outside the query`);
    return `events ${haps.map(String).join(';')}`;
  } catch (e) {
    if (e instanceof PatternError) return `error ${e.message}`;
    throw new Error(`${JSON.stringify(src)} threw something else: ${(e as Error).stack}`);
  }
}

test('grammatical strings parse and query (or fail cleanly), fast, and always the same way', () => {
  let parsed = 0;
  for (let seed = 0; seed < 1500; seed++) {
    const src = grammatical(new Rng(seed));
    const started = performance.now();
    const first = outcome(src);
    assert.ok(performance.now() - started < 2000, `${JSON.stringify(src)} took ${(performance.now() - started).toFixed(0)} ms`);
    assert.equal(outcome(src), first, `${JSON.stringify(src)} is not deterministic`);
    if (first.startsWith('events')) parsed++;
  }
  assert.ok(parsed > 1000, `${parsed} of 1500 grammatical strings gave events`);
});

test('mutated strings only ever give events or a parse error', () => {
  let errors = 0;
  for (let seed = 0; seed < 1500; seed++) {
    const r = new Rng(seed + 10000);
    const src = mutate(r, grammatical(r));
    const result = outcome(src);
    if (result.startsWith('error')) errors++;
    assert.equal(outcome(src), result, `${JSON.stringify(src)} is not deterministic`);
  }
  assert.ok(errors > 100, `${errors} of 1500 mutated strings were errors`);
});

test('random glyph soup only ever gives events or a parse error', () => {
  for (let seed = 0; seed < 1500; seed++) outcome(random(new Rng(seed + 20000)));
});

test('the limits hold against hostile strings', () => {
  const r = new Rng(3);
  for (const src of [
    'a'.repeat(MINI_LIMITS.maxLength + 1),
    '['.repeat(100) + 'a' + ']'.repeat(100),
    'a*1000000',
    'a*1000*1000',
    '[a*100]*100*100',
    'a!1024!1024',
    '0 .. 1024 .. 0',
    '{a b c}%1000000',
    'a(1000000,1000000)',
    Array.from({ length: 200 }, () => grammatical(r)).join(' ')
  ]) {
    const result = outcome(src);
    assert.ok(result.startsWith('error') || result.split(';').length <= LIMITS.maxEvents, src.slice(0, 40));
  }
});
