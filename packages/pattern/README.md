# @noprod/pattern

noprod's pattern engine, built from scratch: the language AI dictation
writes (Strudel's, as users and the model know it) parsed and interpreted by
our own code. Pure TypeScript, no runtime dependencies, no DOM, no `eval`.

Why: every Strudel package is AGPL, and the old headless sequencer ran
LLM-written code as JavaScript in a browser with its sandbox off (#133).

```ts
import { fastcat, slowcat, pure } from '@noprod/pattern';

// "bd <sd cp>" by hand (the mini-notation parser lands in the next step)
const pat = fastcat('bd', slowcat('sd', 'cp'));
pat.firstCycle().map(String);
// ['0 → 1/2: "bd"', '1/2 → 1: "sd"']
pat.queryArc(1, 2).map(String);
// ['1 → 3/2: "bd"', '3/2 → 2: "cp"']
```

## Time and events

- Time is measured in **cycles**, as exact fractions (`Fraction`): `1/3 +
  1/3 + 1/3` is exactly `1`, so polyrhythms never drift. Fractions too fine
  to stay exact (denominators past 2^53) are an error, not a rounding.
- A **span** (`TimeSpan`) is `[begin, end)`.
- A **pattern** (`Pattern<T>`) is a function from a span to the events in
  it: `pat.query(span)`. `queryArc(begin, end)` answers cycle by cycle and
  in time order; `firstCycle()` gives the events that start in cycle 0, which
  is what a one-bar loop plays.
- An **event** (`Hap<T>`) has a **whole** (the span it occupies), a **part**
  (the piece of it inside the query) and a value. An event whose part begins
  where its whole does `hasOnset()`: that is where it is played. Signals
  (`saw`, `sine`, `rand`) have no whole: they are sampled at the middle of
  each query.

## Combinators

| | |
|---|---|
| `pure(v)`, `silence`, `signal(f)` | one event per cycle; nothing; a continuous value |
| `fastcat`/`seq`/`sequence`, `slowcat`/`cat`, `timecat`, `stack`, `polymeter`, `randcat`, `choose` | all in one cycle; one per cycle; weighted steps; at once; `{a b c, d e}%4`; a random one per cycle |
| `.fast(f)`, `.slow(f)`, `.early(t)`, `.late(t)`, `.rev()`, `.palindrome()`, `.iter(n)`, `.compress(b, e)`, `.focus(span)` | time |
| `.every(n, f)`, `.lastOf(n, f)`, `.struct(bools)`, `.mask(bools)`, `.euclid(k, n, r)`, `.ply(n)`, `.off(t, f)`, `.superimpose(f)`, `.layer(...fs)` | structure |
| `.degradeBy(p)`, `.sometimesBy(p, f)`, `.sometimes`, `.often`, `.rarely`, `.someCyclesBy(p, f)` | seeded randomness |
| `.fmap(f)`, `.filterValues(f)`, `.appLeft(other, f)`, `.appBoth(other, f)`, `.innerJoin()`, `.outerJoin()`, `.squeezeJoin()` | values, combining, patterns of patterns |

Arguments that take a number also take a pattern of numbers (`patternify`):
`pat.fast(slowcat(2, 3))` plays twice as fast one cycle and three times the
next. Each value of the argument applies while it lasts; the structure stays
the transformed pattern's.

Semantics worth knowing, matching the published language:

- `slowcat` gives each pattern its own count of cycles, so `<a <b c>>` plays
  `a b a c`, and the same alternation twice in one cycle gives the same step
  twice (`<a b>!2 c` is `a a c`, then `b b c`).
- A step that lasts longer than its slot only sounds when its onset falls in
  the slot: `a b/2` plays `b` every other cycle.
- `every(n, f)` applies `f` to cycles 0, n, 2n…; `lastOf` to n−1, 2n−1…
- Euclidean rhythms are Bjorklund's: `(3,8)` is `x..x..x.`, `(5,8)` is
  `x.xx.xx.`; the rotation moves the hits later by that many steps, and a
  negative count of hits inverts hits and rests.
- Randomness is a hash of the event's time and a seed, so the same pattern
  always gives the same events, and `degradeBy(p)` and `sometimesBy(p, f)`
  pick complementary shares (`f` is applied to the events `degradeBy`
  would drop).

## Limits

Dictated code is untrusted. A query carries a `Budget`: the events made
while answering it (`maxEvents`, 20 000 by default, counting every layer)
and the time it may take (`maxMillis`, 1 000). Past either, the query stops
with a `PatternError` that says so. `pat.queryArc(0, 1, { maxEvents: 1000 })`
sets them per query.

## Tests

`npm test` here runs `test/*.test.ts` with Node's test runner: expected
events written out by hand for every combinator, and properties checked over
hundreds of generated patterns (a query over `[0, 2)` equals `[0, 1)` then
`[1, 2)`; `fast(2)` equals the pattern with its time halved; the same input
always gives the same events; every part lies inside its whole).

## Clean-room

This package is written from Strudel's and Tidal's public documentation and
from observing what the published engine outputs for given programs. Nobody
working on it reads Strudel's source. The names match the language users
write; the code is ours.
