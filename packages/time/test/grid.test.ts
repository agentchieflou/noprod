import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICKS_PER_BEAT, DIVISIONS, toTicks, fromTicks, divisionBeats, snap, gridAround, quantize, onGrid } from '../src/grid.ts';

test('ticks: 960 to the quarter note, and back exactly', () => {
  assert.equal(TICKS_PER_BEAT, 960);
  assert.equal(toTicks(1.5), 1440);
  assert.equal(fromTicks(1440), 1.5);
  for (let t = 0; t < 10000; t += 7) assert.equal(toTicks(fromTicks(t)), t);
  assert.equal(toTicks(1 / 3), 320);
});

test('divisions: note values and their triplets, in beats', () => {
  assert.equal(divisionBeats('1/1'), 4);
  assert.equal(divisionBeats('1/4'), 1);
  assert.equal(divisionBeats('1/16'), 0.25);
  assert.equal(divisionBeats('1/8T'), 1 / 3);
  assert.equal(divisionBeats('1/4T'), 2 / 3);
  for (const d of DIVISIONS) assert.ok(divisionBeats(d) > 0, d);
});

test('snapping and the lines around a beat', () => {
  assert.equal(snap(1.1, 0.25), 1);
  assert.equal(snap(1.13, 0.25), 1.25);
  assert.equal(snap(1.1, 0), 1.1);
  assert.equal(snap(5.2, 1, 0.5), 5.5);
  assert.deepEqual(gridAround(1.1, 0.25), { below: 1, above: 1.25 });
  assert.deepEqual(gridAround(1.25, 0.25), { below: 1.25, above: 1.25 });
  assert.deepEqual(gridAround(2.1, 1 / 3), { below: 2, above: 2 + 1 / 3 });
  assert.deepEqual(gridAround(2, 1 / 3), { below: 2, above: 2 });
  assert.ok(onGrid(2, 1 / 3));
  assert.ok(onGrid(2 + 2 / 3, 1 / 3));
  assert.ok(!onGrid(2.1, 1 / 3));
});

test('quantize moves toward the grid by its strength', () => {
  assert.equal(quantize(1.1, 0.5), 1);
  assert.equal(quantize(1.1, 0.5, 0.5), 1.05);
  assert.equal(quantize(1.1, 0.5, 0), 1.1);
  assert.equal(quantize(1.1, 0.5, 2), 1);
});
