import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pattern, Fraction, TimeSpan, Hap, pure, stack, slowcat, fastcat, timecat, randcat, polymeter } from '../src/index.ts';
import { hashNumbers } from '../src/index.ts';

// A small seeded generator of random patterns out of the core combinators,
// so the properties below hold for shapes nobody wrote by hand
class Gen {
  private state: number;
  constructor(seed: number) { this.state = hashNumbers(seed, 0x5eed); }
  next(): number { this.state = hashNumbers(this.state, 1); return this.state / 2 ** 32; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(xs: T[]): T { return xs[this.int(xs.length)]; }
  pattern(depth = 0): Pattern<string> {
    const leaf = () => pure(this.pick(['a', 'b', 'c', 'd']));
    if (depth > 3 || this.next() < 0.25) return leaf();
    const sub = () => this.pattern(depth + 1);
    const many = () => Array.from({ length: 1 + this.int(3) }, sub);
    switch (this.int(14)) {
      case 0: return fastcat(...many());
      case 1: return slowcat(...many());
      case 2: return stack(...many());
      case 3: return timecat(...many().map((p) => [1 + this.int(3), p] as [number, Pattern<string>]));
      case 4: return sub().fast(this.pick([2, 3, new Fraction(3, 2), slowcat(1, 2)]));
      case 5: return sub().slow(this.pick([2, 3, new Fraction(3, 2)]));
      case 6: return sub().late(this.pick([new Fraction(1, 4), new Fraction(1, 3), new Fraction(5, 8)]));
      case 7: return sub().rev();
      case 8: return sub().every(1 + this.int(3), (p) => p.fast(2));
      case 9: return sub().euclid(1 + this.int(5), 3 + this.int(6), this.int(3));
      case 10: return sub().ply(1 + this.int(3));
      case 11: return sub().degradeBy(this.next(), this.int(5));
      case 12: return randcat(many(), this.int(5));
      default: return polymeter([many(), many()], 2 + this.int(4));
    }
  }
}

const key = (h: { whole?: TimeSpan; part: TimeSpan; value: unknown }) => `${h.whole ?? '~'} | ${h.part} | ${JSON.stringify(h.value)}`;
const sorted = (xs: string[]) => [...xs].sort();

// A query may hand an event back in several fragments (one per cycle, say);
// joined back together, two ways of querying the same events agree
function merged(haps: Hap<unknown>[]): string[] {
  const byWhole = new Map<string, Hap<unknown>[]>();
  for (const h of haps) {
    const k = `${h.whole ?? '~'} ${JSON.stringify(h.value)}`;
    byWhole.set(k, [...(byWhole.get(k) ?? []), h]);
  }
  const out: string[] = [];
  for (const [k, group] of byWhole) {
    // chain each fragment with the ones that start where it ends (the same
    // event may be there twice, from a stack, so this is a multiset)
    const parts = group.map((h) => h.part).sort((a, b) => a.begin.compare(b.begin));
    while (parts.length) {
      let current = parts.shift()!;
      for (let i = parts.findIndex((p) => p.begin.eq(current.end)); i >= 0; i = parts.findIndex((p) => p.begin.eq(current.end))) {
        current = new TimeSpan(current.begin, parts.splice(i, 1)[0].end);
      }
      out.push(`${k} | ${current}`);
    }
  }
  return out.sort();
}

test('querying [0, 2) equals querying [0, 1) and [1, 2)', () => {
  for (let seed = 0; seed < 200; seed++) {
    const pat = new Gen(seed).pattern();
    const whole = pat.queryArc(0, 2).map(key);
    const halves = [...pat.queryArc(0, 1), ...pat.queryArc(1, 2)].map(key);
    assert.deepEqual(sorted(whole), sorted(halves), `pattern ${seed}`);
    // and as one raw query, once fragments are joined back together
    assert.deepEqual(merged(pat.query(new TimeSpan(0, 2))), merged([...pat.query(new TimeSpan(0, 1)), ...pat.query(new TimeSpan(1, 2))]), `pattern ${seed}`);
  }
});

test('any split of a query gives the same events, as fragments of the same wholes', () => {
  for (let seed = 0; seed < 200; seed++) {
    const pat = new Gen(seed).pattern();
    const cut = new Gen(seed + 1000).pick([new Fraction(1, 3), new Fraction(1, 2), new Fraction(7, 8), new Fraction(5, 4)]);
    assert.deepEqual(merged(pat.queryArc(0, 2)), merged([...pat.queryArc(0, cut), ...pat.queryArc(cut, 2)]), `pattern ${seed} cut at ${cut}`);
  }
});

test('fast(2) of a pattern equals the pattern with its time halved', () => {
  const halve = (t: Fraction) => t.div(2);
  for (let seed = 0; seed < 200; seed++) {
    const pat = new Gen(seed).pattern();
    const fast = pat.fast(2).queryArc(0, 1);
    const halved = pat.queryArc(0, 2).map((h) => h.withSpan((s) => s.withTime(halve)));
    assert.deepEqual(merged(fast), merged(halved), `pattern ${seed}`);
  }
});

test('slow(2) then fast(2), and late then early, give the pattern back', () => {
  for (let seed = 0; seed < 100; seed++) {
    const pat = new Gen(seed).pattern();
    const original = merged(pat.queryArc(0, 3));
    assert.deepEqual(merged(pat.slow(2).fast(2).queryArc(0, 3)), original, `pattern ${seed}`);
    assert.deepEqual(merged(pat.late(new Fraction(3, 8)).early(new Fraction(3, 8)).queryArc(0, 3)), original, `pattern ${seed}`);
    assert.deepEqual(merged(pat.rev().rev().queryArc(0, 3)), original, `pattern ${seed}`);
  }
});

test('the same input always gives the same events', () => {
  for (let seed = 0; seed < 100; seed++) {
    const a = new Gen(seed).pattern().queryArc(0, 4).map(key);
    const b = new Gen(seed).pattern().queryArc(0, 4).map(key);
    assert.deepEqual(a, b, `pattern ${seed}`);
  }
  // including the random operators, across separate instances
  const hats = () => pure('h').fast(16).degradeBy(0.5, 3).sometimesBy(0.3, (p) => p.fmap(() => 'H'), 4);
  assert.deepEqual(hats().queryArc(0, 8).map(key), hats().queryArc(0, 8).map(key));
  assert.deepEqual(randcat(['a', 'b', 'c'], 7).queryArc(0, 32).map(key), randcat(['a', 'b', 'c'], 7).queryArc(0, 32).map(key));
});

test('every part lies inside its whole, and inside the query', () => {
  for (let seed = 0; seed < 200; seed++) {
    const pat = new Gen(seed).pattern();
    const span = new TimeSpan(new Fraction(1, 3), new Fraction(7, 3));
    for (const h of pat.query(span)) {
      assert.ok(h.part.begin.gte(span.begin) && h.part.end.lte(span.end), `pattern ${seed}: part ${h.part} outside the query`);
      if (h.whole) assert.ok(h.part.begin.gte(h.whole.begin) && h.part.end.lte(h.whole.end), `pattern ${seed}: part ${h.part} outside whole ${h.whole}`);
      assert.ok(h.part.begin.lte(h.part.end));
    }
  }
});
