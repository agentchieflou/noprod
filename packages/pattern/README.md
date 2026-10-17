# @noprod/pattern

noprod's pattern engine, built from scratch: the language AI dictation
writes (Strudel's, as users and the model know it) parsed and interpreted by
our own code. Pure TypeScript, no runtime dependencies, no DOM, no `eval`.

Why: every Strudel package is AGPL, and the old headless sequencer ran
LLM-written code as JavaScript in a browser with its sandbox off (#133).

```ts
import { mini } from '@noprod/pattern';

const pat = mini('bd <sd cp>');
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

## The mini-notation

`mini(string)` parses the string language inside `note("…")` and `s("…")`
with our own tokenizer and recursive-descent parser (`parseMini` gives the
tree, `toPattern` interprets it with the combinators below). Wherever the
engine wants a pattern, a string is read as mini-notation: `pat.struct("t ~
t t")`, `pat.fast("<1 2>")`.

| | |
|---|---|
| `a b c` | a sequence: the cycle shared equally |
| `~` | a rest |
| `[a b]` | a sub-sequence in one step |
| `<a b>` | alternation: one step per cycle (`<a <b c>>` plays `a b a c`) |
| `a*2`, `a/2` | faster, slower; the factor may be a pattern: `a*<2 3>`, `a*[2 3]` |
| `a!3`, `a ! !` | the step repeated (the same step: `<a b>!2 c` is `a a c`, then `b b c`) |
| `a@3`, `a _ _` | the step lengthened (in `<>`, lengthened in cycles) |
| `a, b` | polyphony: both at once (`[c4,e4,g4]` is a chord) |
| `a(3,8)`, `a(3,8,2)` | a Euclidean rhythm: 3 hits over 8 steps, turned 2 steps later; the arguments may be patterns |
| `a:3` | a sample index, kept in the value (`"a:3"`) |
| `a?`, `a?0.2` | dropped at random, half the time or with the probability given |
| `a \| b` | one of them per cycle, at random |
| `a . b c` | groups: `a` then `[b c]` |
| `0 .. 3` | a range of whole numbers: `0 1 2 3` |
| `{a b c, d e}%4` | polymeter: every layer steps at the same rate, 4 steps a cycle (the first layer's length by default) |

Words are strings (`bd`, `c#3`, `gm_epiano1`, `RolandTR909`, `C:major`);
numbers are numbers (`0`, `-1`, `0.5`); `t`, `f`, `1` and `0` make a rhythm
for `struct` and `mask` (`f`, `false` and `0` are off). Randomness (`?`,
`|`) is seeded by the operator's position in the string, so the same string
always gives the same events, and each `?` is its own stream.

A parse error is a `PatternError` with a message and a position
(`"expected "]" but found the end at 1:5"`). Limits: a string of at most
10 000 characters, brackets at most 32 deep, `!` and `..` at most 1024
steps, Euclidean rhythms of at most 1024 steps.

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
  `x.xx.xx.`; the rotation moves the hits later by that many steps
  (`(3,8,2)` is `x.x..x..`, steps 0, 2 and 5, as the published engine
  plays it; Tidal's text describes the turn as leftward), and a negative
  count of hits inverts hits and rests.
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
events written out by hand for every combinator and every mini-notation
operator; properties checked over hundreds of generated patterns (a query
over `[0, 2)` equals `[0, 1)` then `[1, 2)`; `fast(2)` equals the pattern
with its time halved; the same input always gives the same events; every
part lies inside its whole); and a fuzz test of the parser: thousands of
generated, mutated and random strings only ever give events or a
`PatternError`, within the limits, always the same way. `test/observed.test.ts`
pins a set of strings to the onsets the published engine was observed to
give for them (Euclid rotation, nested alternation, `!`, `/`, polymeter).

## Clean-room

This package is written from Strudel's and Tidal's public documentation and
from observing what the published engine outputs for given programs. Nobody
working on it reads Strudel's source. The names match the language users
write; the code is ours.
