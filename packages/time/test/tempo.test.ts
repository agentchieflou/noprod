import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap, MIN_BPM, MAX_BPM, type TempoEvent } from '../src/tempo.ts';

// A small deterministic generator, so a failing map can be rerun
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const close = (a: number, b: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b} (off by ${Math.abs(a - b)})`);

// ∫ 60 / bpm(b) db by the trapezoid rule, a check on the closed form. The
// tempo can step at an event, so each stretch between events is integrated
// on its own, where the integrand is smooth.
function integrate(map: TempoMap, from: number, to: number, steps = 200000) {
  const cuts = [from, ...map.events.map((e) => e.beat).filter((b) => b > from && b < to), to];
  let total = 0;
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c], b = cuts[c + 1];
    const h = (b - a) / steps;
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
      const w = i === 0 || i === steps ? 0.5 : 1;
      sum += (w * 60) / map.bpmAt(Math.min(a + i * h, b - 1e-12));
    }
    total += sum * h;
  }
  return total;
}

test('a constant tempo: beats are seconds times bpm over 60', () => {
  const map = new TempoMap();
  assert.equal(map.bpmAt(0), 120);
  assert.equal(map.secondsAt(4), 2);
  assert.equal(map.beatAt(2), 4);
  assert.equal(map.secondsAt(-4), -2);        // a count-in, before the song
  assert.equal(map.beatAt(-2), -4);
  assert.equal(map.secondsBetween(2, 6), 2);
});

test('tempo steps hold until the next event', () => {
  const map = new TempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]);
  assert.equal(map.secondsAt(8), 4);
  assert.equal(map.secondsAt(12), 8);
  assert.equal(map.beatAt(6), 10);
  assert.equal(map.bpmAt(7.999), 120);
  assert.equal(map.bpmAt(8), 60);
  assert.equal(map.bpmAt(1000), 60);
});

test('a ramp integrates as the closed form says, and inverts', () => {
  const map = new TempoMap([{ beat: 0, bpm: 120, ramp: 'linear' }, { beat: 8, bpm: 60 }, { beat: 16, bpm: 90 }]);
  assert.equal(map.bpmAt(4), 90);
  close(map.secondsAt(8), integrate(map, 0, 8), 1e-7, 'the ramp');
  close(map.secondsAt(5), integrate(map, 0, 5), 1e-7, 'inside the ramp');
  close(map.secondsAt(13), integrate(map, 0, 13), 1e-7, 'past the ramp');
  for (const b of [0, 0.5, 3, 7.99, 8, 12, 20]) close(map.beatAt(map.secondsAt(b)), b, 1e-9, `round trip at ${b}`);
});

test('a ramp to the same tempo is constant', () => {
  const map = new TempoMap([{ beat: 0, bpm: 100, ramp: 'linear' }, { beat: 4, bpm: 100 }]);
  assert.equal(map.secondsAt(4), 2.4);
  assert.equal(map.beatAt(2.4), 4);
});

test('a ramp on the last event holds its tempo', () => {
  const map = new TempoMap([{ beat: 0, bpm: 120, ramp: 'linear' }]);
  assert.equal(map.bpmAt(100), 120);
  assert.equal(map.secondsAt(100), 50);
});

test('random maps: round trips to 1e-9 beats, monotonic, bpm within its range', () => {
  const rnd = random(159);
  for (let n = 0; n < 60; n++) {
    const events: TempoEvent[] = [];
    const count = Math.floor(rnd() * 20);
    for (let i = 0; i < count; i++) {
      events.push({ beat: Math.floor(rnd() * 4000) / 2, bpm: MIN_BPM + rnd() * (MAX_BPM - MIN_BPM), ...(rnd() < 0.5 ? { ramp: 'linear' as const } : {}) });
    }
    const map = new TempoMap(events);
    let lastBeat = -100, lastSeconds = map.secondsAt(-100);
    for (let i = 0; i < 200; i++) {
      const beat = -8 + rnd() * 4100;
      const seconds = map.secondsAt(beat);
      close(map.beatAt(seconds), beat, 1e-9, `map ${n} beat ${beat}`);
      const bpm = map.bpmAt(beat);
      assert.ok(bpm >= MIN_BPM - 1e-9 && bpm <= MAX_BPM + 1e-9, `bpm ${bpm} out of range`);
      if (beat > lastBeat) assert.ok(seconds > lastSeconds, `not monotonic at ${beat}`);
      else assert.ok(seconds < lastSeconds, `not monotonic at ${beat}`);
      lastBeat = beat; lastSeconds = seconds;
    }
    // the closed form against numeric integration on a random stretch
    const a = rnd() * 2000, b = a + rnd() * 500;
    close(map.secondsBetween(a, b), integrate(map, a, b, 20000), 1e-6 * Math.max(1, b - a), `integral of map ${n}`);
  }
});

test('events are sorted, one per beat, clamped, and beat 0 always has one', () => {
  const map = new TempoMap([{ beat: 8, bpm: 2000 }, { beat: 4, bpm: 5 }, { beat: 4, bpm: 90 }, { beat: -3, bpm: 70 }]);
  assert.deepEqual(map.toJSON(), [{ beat: 0, bpm: 70 }, { beat: 4, bpm: 90 }, { beat: 8, bpm: MAX_BPM }]);
  assert.deepEqual(new TempoMap([{ beat: 16, bpm: 100 }]).toJSON(), [{ beat: 0, bpm: 100 }, { beat: 16, bpm: 100 }]);
  assert.deepEqual(new TempoMap([]).toJSON(), [{ beat: 0, bpm: 120 }]);
  assert.deepEqual(new TempoMap([{ beat: 0, bpm: NaN }]).toJSON(), [{ beat: 0, bpm: 120 }]);
});

test('edits: the tempo in effect, an event added or removed', () => {
  const map = new TempoMap([{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }]);
  assert.deepEqual(map.withTempoAt(20, 100).toJSON(), [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 100 }]);
  assert.deepEqual(map.withTempoAt(3, 130).toJSON(), [{ beat: 0, bpm: 130 }, { beat: 16, bpm: 90 }]);
  assert.deepEqual(map.withTempoAt(-5, 130).toJSON(), [{ beat: 0, bpm: 130 }, { beat: 16, bpm: 90 }]);
  assert.deepEqual(map.withEvent({ beat: 8, bpm: 100, ramp: 'linear' }).toJSON(),
    [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 100, ramp: 'linear' }, { beat: 16, bpm: 90 }]);
  assert.deepEqual(map.withEvent({ beat: 16, bpm: 80 }).toJSON(), [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 80 }]);
  assert.deepEqual(map.withoutEvent(16).toJSON(), [{ beat: 0, bpm: 120 }]);
  assert.equal(map.withoutEvent(0), map);
  assert.equal(map.events.length, 2, 'the map itself is unchanged');
});

test('a map survives JSON', () => {
  const map = new TempoMap([{ beat: 0, bpm: 120, ramp: 'linear' }, { beat: 8, bpm: 60 }]);
  const back = TempoMap.from(JSON.parse(JSON.stringify(map)));
  assert.deepEqual(back.toJSON(), map.toJSON());
  assert.equal(back.secondsAt(8), map.secondsAt(8));
  assert.deepEqual(TempoMap.from('nonsense').toJSON(), [{ beat: 0, bpm: 120 }]);
});
