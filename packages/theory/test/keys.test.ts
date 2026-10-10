import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyTracker, findKey, keyName, parseNote, pc } from '../src/index.ts';

const histogramOf = (notes: string) => {
  const counts = new Array<number>(12).fill(0);
  for (const name of notes.split(' ')) counts[pc(parseNote(name))]++;
  return counts;
};

test('a C major scale is in C major', () => {
  const estimate = findKey(histogramOf('C4 D4 E4 F4 G4 A4 B4 C5'));
  assert.equal(keyName(estimate.key), 'C major');
  assert.equal(estimate.ranked.length, 24);
  assert.equal(estimate.ranked[0].score, estimate.score);
  for (let i = 1; i < 24; i++) assert.ok(estimate.ranked[i - 1].score >= estimate.ranked[i].score);
  // Its relative minor is the runner-up
  assert.equal(keyName(estimate.ranked[1].key), 'A minor');
});

test('an A natural minor melody that dwells on A is in A minor', () => {
  const melody = 'A4 C5 E5 A4 G4 A4 B4 C5 D5 E5 F5 E5 D5 C5 B4 A4 E4 A4 C5 B4 A4';
  assert.equal(keyName(findKey(histogramOf(melody)).key), 'A minor');
});

test('an F major scale is in F major', () => {
  assert.equal(keyName(findKey(histogramOf('F4 G4 A4 Bb4 C5 D5 E5 F5')).key), 'F major');
});

test('an E major tune is in E major and a D minor one in D minor', () => {
  assert.equal(keyName(findKey(histogramOf('E4 G#4 B4 E5 B4 G#4 F#4 E4 D#4 E4 A4 C#5 B4 E4')).key), 'E major');
  assert.equal(keyName(findKey(histogramOf('D4 F4 A4 D5 A4 F4 E4 D4 C#4 D4 G4 Bb4 A4 D4')).key), 'D minor');
});

test('an empty histogram reads as C major', () => {
  assert.equal(keyName(findKey(new Array(12).fill(0)).key), 'C major');
});

test('the key tracker forgets old notes: C major, then a long while of E major', () => {
  const tracker = new KeyTracker(8);
  const cMajor = [60, 62, 64, 65, 67, 69, 71, 72];
  cMajor.forEach((p, i) => tracker.observe(p, i * 0.5, 1));
  assert.equal(keyName(tracker.key()), 'C major');

  const eMajor = [64, 66, 68, 69, 71, 73, 75, 76];
  for (let bar = 0; bar < 8; bar++) {
    eMajor.forEach((p, i) => tracker.observe(p, 10 + bar * 4 + i * 0.5, 1));
  }
  assert.equal(keyName(tracker.key()), 'E major');
  // C and F (not in E major) have faded to almost nothing
  const histogram = tracker.histogram();
  assert.ok(histogram[0] < 0.05 * histogram[4], `C ${histogram[0]} vs E ${histogram[4]}`);
});

test('old notes halve every half-life; longer notes count more', () => {
  const tracker = new KeyTracker(2);
  tracker.observe(60, 0, 1);
  tracker.observe(67, 2, 1);
  assert.ok(Math.abs(tracker.histogram()[0] - 0.5) < 1e-9);
  tracker.observe(67, 2, 1.5);   // a note-off after 1.5 s
  assert.equal(tracker.histogram()[7], 2.5);
});

test('the key does not flicker between close keys, but follows a clear change', () => {
  // A C major tune drifting into G major (F# arrives)
  const tune = [60, 62, 64, 65, 67, 69, 71, 72, 67, 66, 67, 69, 71, 74, 66, 67];
  const tracker = new KeyTracker(8);
  let closeCalls = 0;
  tune.forEach((p, i) => {
    tracker.observe(p, i * 0.5);
    const best = findKey(tracker.histogram());
    const current = best.ranked.find(r => keyName(r.key) === keyName(tracker.key()))!;
    // The tracker may keep its key only while the best one leads by a little
    if (current.score !== best.score) {
      closeCalls++;
      assert.ok(best.score - current.score <= 0.05);
    }
  });
  assert.ok(closeCalls > 0, 'the key held on through a close call');
  assert.equal(keyName(tracker.key()), 'G major');
});
