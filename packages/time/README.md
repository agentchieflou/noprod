# @noprod/time

noprod's musical time. Positions are **float64 beats**, one beat being a
quarter note, whatever the time signature; the tempo map turns beats into
seconds and back, and the meter map into bars and grid lines. Pure
TypeScript, no dependencies, no DOM: the DAW's model, scheduler and rulers
all count in these beats, and only the engine's clock and the samples are in
seconds.

```ts
import { TempoMap, MeterMap, snap, divisionBeats } from '@noprod/time';

const tempo = new TempoMap([{ beat: 0, bpm: 120, ramp: 'linear' }, { beat: 16, bpm: 90 }]);
tempo.secondsAt(16);           // 9.33: the ramp's integral, in closed form
tempo.beatAt(9.33);            // 16
tempo.bpmAt(8);                // 105, halfway down the ramp

const meter = new MeterMap([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 8, numerator: 6, denominator: 8 }]);
meter.bbt(33.5);               // { bar: 9, beat: 4, tick: 0 }: the fourth eighth of a 6/8 bar
meter.grid(32, 35);            // the six eighth-note lines of that bar, the first accented
meter.snap(33.7, divisionBeats('1/8'));   // 33.5

snap(1.13, divisionBeats('1/16'));        // 1.25
```

## The tempo map

A sorted list of `{ beat, bpm, ramp? }`, always with an event at beat 0. An
event holds its tempo until the next one; with `ramp: 'linear'` the tempo
moves linearly in BPM over the beats to the next event, as Ableton's and Pro
Tools' tempo ramps do. Both directions have closed forms (`src/tempo.ts`),
so `secondsAt` and `beatAt` are a binary search and one formula each, and
the map is monotonic by construction. Before beat 0 the first tempo holds
(a count-in has negative beats); after the last event its tempo holds.

`withTempoAt(beat, bpm)` edits the tempo in effect at a beat: it is what
the tempo field, the Tempo Follower and a scene's tempo override do. The
maps are immutable; every edit returns a new one.

## The meter map

Today's `timeSignatures`: `{ bar, numerator, denominator }` indexed by
0-based bar, bar 0 always present. A bar of n/d is `n · 4 / d` beats: 6/8
is three beats long and has six grid lines. `bbt` shows a position as
1-based bar and beat, where a beat is one 1/d note, with ticks at
`TICKS_PER_BEAT` (960) per quarter note; `fromBbt` reads one back. `grid`
lists the 1/d-note lines in a range, the first of each bar accented, for
rulers and the metronome; `snap` snaps to a step counted from the bar line,
so a quarter-note grid in 7/8 restarts on every bar.

## Grids

`divisionBeats('1/16')` is a quarter of a beat and `'1/8T'` a third;
`snap`, `gridAround`, `quantize` (with a strength) and `onGrid` work on any
step from any origin. Equality on a grid is by snapping: positions are
doubles, and a tick (1/960 of a beat) is the finest difference that counts.

## Tests

`node --test test/*.test.ts`: the ramp formula against numeric integration,
beat→seconds→beat round trips to 1e-9 beats on random maps a thousand bars
long, monotonicity, bars and grids through signature changes, and every edit.
