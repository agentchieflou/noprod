import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeterMap, beatsPerBar } from '../src/meter.ts';

const beats = (lines: { beat: number }[]) => lines.map((l) => l.beat);

test('4/4: four beats a bar, bars.beats.ticks from 1', () => {
  const map = new MeterMap();
  assert.equal(map.beatOfBar(3), 12);
  assert.deepEqual(map.barAt(13.5), { index: 3, start: 12, length: 4, numerator: 4, denominator: 4 });
  assert.deepEqual(map.bbt(13.5), { bar: 4, beat: 2, tick: 480 });
  assert.deepEqual(map.bbt(0), { bar: 1, beat: 1, tick: 0 });
  assert.equal(map.fromBbt({ bar: 4, beat: 2, tick: 480 }), 13.5);
  assert.equal(map.fromBbt(map.bbt(37.25)), 37.25);
});

test('signature changes on bar lines', () => {
  const map = new MeterMap([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 2, numerator: 3, denominator: 4 }, { bar: 4, numerator: 6, denominator: 8 }]);
  assert.equal(beatsPerBar({ numerator: 6, denominator: 8 }), 3);
  assert.equal(map.beatOfBar(2), 8);
  assert.equal(map.beatOfBar(4), 14);
  assert.equal(map.beatOfBar(5), 17);
  assert.deepEqual(map.barAt(16), { index: 4, start: 14, length: 3, numerator: 6, denominator: 8 });
  assert.deepEqual(map.bbt(16), { bar: 5, beat: 5, tick: 0 });          // 2 beats into a 6/8 bar is its 5th eighth
  assert.deepEqual(map.bbt(16.25), { bar: 5, beat: 5, tick: 240 });
  assert.equal(map.fromBbt({ bar: 5, beat: 5, tick: 240 }), 16.25);
  assert.deepEqual(map.meterAt(3), { bar: 2, numerator: 3, denominator: 4 });
  assert.deepEqual(map.meterAt(99), { bar: 4, numerator: 6, denominator: 8 });
});

test('the grid: one line per 1/d note, accented on the bar', () => {
  const map = new MeterMap([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 1, numerator: 6, denominator: 8 }]);
  const lines = map.grid(2, 7);
  assert.deepEqual(beats(lines), [2, 3, 4, 4.5, 5, 5.5, 6, 6.5]);
  assert.deepEqual(lines.map((l) => l.accent), [false, false, true, false, false, false, false, false]);
  assert.deepEqual(map.barsBetween(3, 8).map((b) => b.index), [0, 1, 2]);
  assert.deepEqual(map.grid(5, 5), []);
});

test('before the song: the first signature reaches back', () => {
  const map = new MeterMap([{ bar: 0, numerator: 3, denominator: 4 }]);
  assert.equal(map.beatOfBar(-2), -6);
  assert.deepEqual(map.barAt(-1), { index: -1, start: -3, length: 3, numerator: 3, denominator: 4 });
  assert.deepEqual(map.bbt(-1), { bar: 0, beat: 3, tick: 0 });
  assert.deepEqual(beats(map.grid(-3, 0)), [-3, -2, -1]);
});

test('snapping restarts on every bar line', () => {
  const map = new MeterMap([{ bar: 0, numerator: 7, denominator: 8 }]);   // bars of 3.5 beats
  assert.equal(map.snap(3.6, 1), 3.5);
  assert.equal(map.snap(4.3, 1), 4.5);
  assert.equal(map.snap(6.9, 1), 7);          // nearer the next bar line than beat 6.5
  assert.equal(map.snap(2.2, 0.5), 2);
  assert.equal(map.snap(2.2, 0), 2.2);
});

test('events are sorted, one per bar, valid, and bar 0 always has one', () => {
  const map = new MeterMap([{ bar: 4, numerator: 3, denominator: 4 }, { bar: 2, numerator: 5, denominator: 4 }, { bar: 2, numerator: 6, denominator: 8 }, { bar: 1.5, numerator: 4, denominator: 4 }, { bar: 3, numerator: 0, denominator: 4 }]);
  assert.deepEqual(map.toJSON(), [{ bar: 0, numerator: 6, denominator: 8 }, { bar: 2, numerator: 6, denominator: 8 }, { bar: 4, numerator: 3, denominator: 4 }]);
  assert.deepEqual(new MeterMap([]).toJSON(), [{ bar: 0, numerator: 4, denominator: 4 }]);
  assert.deepEqual(MeterMap.from(null).toJSON(), [{ bar: 0, numerator: 4, denominator: 4 }]);
});

test('edits: a signature set or removed', () => {
  const map = new MeterMap();
  const edited = map.withMeter(2, 3, 4);
  assert.deepEqual(edited.toJSON(), [{ bar: 0, numerator: 4, denominator: 4 }, { bar: 2, numerator: 3, denominator: 4 }]);
  assert.deepEqual(edited.withMeter(2, 5, 4).toJSON(), [{ bar: 0, numerator: 4, denominator: 4 }, { bar: 2, numerator: 5, denominator: 4 }]);
  assert.deepEqual(edited.withoutMeter(2).toJSON(), map.toJSON());
  assert.equal(edited.withoutMeter(0), edited);
  assert.deepEqual(edited.withMeter(0, 2, 2).toJSON(), [{ bar: 0, numerator: 2, denominator: 2 }, { bar: 2, numerator: 3, denominator: 4 }]);
  assert.equal(map.events.length, 1, 'the map itself is unchanged');
});

test('a map survives JSON', () => {
  const map = new MeterMap([{ bar: 0, numerator: 4, denominator: 4 }, { bar: 8, numerator: 7, denominator: 8 }]);
  assert.deepEqual(MeterMap.from(JSON.parse(JSON.stringify(map))).toJSON(), map.toJSON());
});
