import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coach, LESSONS, findLesson, pc, spellInKey, voiceLead, type Highlight, type Key } from '../src/index.ts';

const C: Key = { tonic: 0, mode: 'major' };

// Plays notes together for `length` seconds from `time`
function play(coach: Coach, pitches: number[], time: number, length = 1) {
  for (const p of pitches) coach.noteOn(p, time, 100);
  for (const p of pitches) coach.noteOff(p, time + length);
}

const ofRole = (highlights: Highlight[], role: Highlight['role']) => highlights.filter(h => h.role === role);
const inRange = (highlights: Highlight[], [low, high]: [number, number]) => highlights.every(h => h.pitch >= low && h.pitch <= high);

test('chords mode: after C and G, the voice-led Am or F lights up', () => {
  const coach = new Coach({ mode: 'chords', key: C });
  play(coach, [60, 64, 67], 0);
  play(coach, [59, 62, 67], 1);
  const { highlights, readout } = coach.suggest();
  assert.equal(readout.chord?.name, 'G/B');
  assert.equal(readout.roman, 'V');
  assert.match(readout.message, /^G\/B \(V\) → try (Am \(vi\) or F \(IV\)|F \(IV\) or Am \(vi\))$/);

  const next = ofRole(highlights, 'next');
  const groups = [0, 1].map(g => next.filter(h => h.group === g).map(h => h.pitch).sort((a, b) => a - b));
  const am = voiceLead([59, 62, 67], 9, 'min'), f = voiceLead([59, 62, 67], 5, 'maj');
  assert.ok(groups.some(g => g.join() === am.join()) && groups.some(g => g.join() === f.join()), JSON.stringify(groups));
  // Each chord's name sits on its root
  for (const group of [0, 1, 2]) {
    const labeled = next.filter(h => h.group === group && h.label);
    assert.equal(labeled.length, 1);
    assert.ok(labeled[0].label!.startsWith(spellInKey(pc(labeled[0].pitch), C)), labeled[0].label);
  }
  assert.equal(readout.suggestions.length, 3);
  assert.ok(inRange(highlights, [48, 84]));
});

test('chords mode: a held chord is named and voice-led from', () => {
  const coach = new Coach({ mode: 'chords', key: C });
  for (const p of [57, 60, 64]) coach.noteOn(p, 0);
  const { highlights, readout } = coach.suggest();
  assert.equal(readout.chord?.name, 'Am');
  assert.equal(readout.roman, 'vi');
  assert.deepEqual(ofRole(highlights, 'held').map(h => h.pitch), [57, 60, 64]);
  assert.match(readout.message, /^Am \(vi\) → try /);
});

test('chords are recorded when they change; a note added to a held chord refines it', () => {
  const coach = new Coach({ mode: 'chords', key: C });
  for (const p of [60, 64, 67]) coach.noteOn(p, 0);
  coach.noteOn(71, 0.2);
  assert.deepEqual(coach.recentChords(), [{ root: 0, quality: 'maj7' }]);
  for (const p of [60, 64, 67, 71]) coach.noteOff(p, 1);
  play(coach, [60, 64, 67, 71], 1);   // the same chord again
  play(coach, [60, 64, 67, 70], 2);   // C7: a new chord on the same root
  play(coach, [53, 57, 60], 3);
  assert.deepEqual(coach.recentChords().map(c => c.quality), ['maj7', '7', 'maj']);
  assert.match(coach.suggest().readout.message, /^F \(IV\) → try /);
});

test('melody mode: the leading tone points home', () => {
  const coach = new Coach({ mode: 'melody', key: C });
  [67, 69, 71].forEach((p, i) => play(coach, [p], i * 0.5, 0.4));
  const { highlights, readout } = coach.suggest();
  const next = ofRole(highlights, 'next').sort((a, b) => b.weight - a.weight);
  assert.equal(next[0].pitch, 72);
  assert.equal(next[0].label, 'C');
  assert.match(readout.message, /^Next: C \(resolves\)/);
});

test('complement mode: C and E held suggest G', () => {
  const coach = new Coach({ mode: 'complement', key: C });
  coach.noteOn(60, 0);
  coach.noteOn(64, 0);
  const { highlights, readout } = coach.suggest();
  const complement = ofRole(highlights, 'complement');
  assert.equal(complement[0].pitch, 67);
  assert.match(readout.message, /^Add G \(completes C\)/);
  assert.equal(coach.held().join(), '60,64');
});

test('lesson mode: the step is the target, a wrong note shows as wrong', () => {
  const coach = new Coach({ mode: 'lesson' });
  coach.setLesson('pop-c');
  const first = findLesson('pop-c')!.steps[0];
  let { highlights, readout } = coach.suggest();
  assert.deepEqual(ofRole(highlights, 'target').map(h => h.pitch), first.pitches);
  assert.equal(readout.message, 'Play C (I): C E G');
  assert.deepEqual(readout.lesson, { id: 'pop-c', name: 'I–V–vi–IV in C', step: 0, total: 4, label: 'C (I)', done: false });

  coach.noteOn(61, 0);
  ({ highlights, readout } = coach.suggest());
  assert.deepEqual(ofRole(highlights, 'wrong').map(h => h.pitch), [61]);
  assert.equal(readout.lesson?.step, 0);
  coach.noteOff(61, 0.5);
  assert.equal(ofRole(coach.suggest().highlights, 'wrong').length, 0);

  play(coach, [48, 52, 55], 1);
  assert.equal(coach.suggest().readout.lesson?.step, 1);
  assert.equal(coach.suggest().readout.message, 'Play G (V): B D G');
  play(coach, [59, 62, 67], 2);
  play(coach, [57, 60, 64], 3);
  play(coach, [53, 57, 60], 4);
  ({ highlights, readout } = coach.suggest());
  assert.equal(readout.message, 'Done!');
  assert.equal(readout.lesson?.done, true);
  assert.equal(ofRole(highlights, 'target').length, 0);
});

test('lesson mode: a melody is judged note by note, legato included', () => {
  const coach = new Coach({ mode: 'lesson' });
  coach.setLesson('mary');
  coach.noteOn(64, 0);
  coach.noteOn(62, 0.4);   // E still held
  coach.noteOff(64, 0.5);
  assert.equal(coach.suggest().readout.lesson?.step, 2);
  assert.equal(coach.suggest().readout.message, 'Play C4');
  assert.equal(ofRole(coach.suggest().highlights, 'wrong').length, 0);
});

test('every highlight lies within the range, in every mode', () => {
  for (const range of [[48, 84], [60, 72], [36, 60]] as [number, number][]) {
    for (const mode of ['off', 'chords', 'melody', 'complement', 'lesson'] as const) {
      const coach = new Coach({ mode, range });
      coach.setLesson(LESSONS[2].id);
      [[57, 61, 64, 67], [62, 66, 69, 72], [64, 68, 71, 74]].forEach((chord, i) => play(coach, chord, i));
      [76, 74, 72, 71, 88, 30].forEach((p, i) => play(coach, [p], 3 + i * 0.25, 0.2));
      coach.noteOn(40, 5);
      coach.noteOn(79, 5);
      const { highlights } = coach.suggest();
      assert.ok(inRange(highlights, range), `${mode} ${range}: ${highlights.map(h => h.pitch).join(' ')}`);
      if (mode !== 'off') assert.ok(highlights.some(h => h.role !== 'held'), `${mode} ${range} suggests something`);
    }
  }
});

test('the auto key starts in C major and follows what is played', () => {
  const coach = new Coach({ mode: 'chords' });
  assert.equal(coach.suggest().readout.keyName, 'C major');
  play(coach, [64, 68, 71], 0);
  assert.equal(coach.suggest().readout.keyName, 'C major');
  const eMajor = [64, 66, 68, 69, 71, 73, 75, 76];
  for (let bar = 0; bar < 3; bar++) eMajor.forEach((p, i) => play(coach, [p], 1 + bar * 4 + i * 0.5, 0.4));
  assert.equal(coach.suggest().readout.keyName, 'E major');
  coach.setKey({ tonic: 5, mode: 'major' });
  assert.equal(coach.suggest().readout.keyName, 'F major');
});

test('the coach is deterministic', () => {
  const run = () => {
    const coach = new Coach({ mode: 'chords' });
    [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]].forEach((chord, i) => play(coach, chord, i));
    const chords = coach.suggest();
    coach.setMode('melody');
    return [chords, coach.suggest()];
  };
  assert.deepEqual(run(), run());
});

test('off mode shows only the held notes', () => {
  const coach = new Coach();
  coach.noteOn(60, 0);
  const { highlights, readout } = coach.suggest();
  assert.deepEqual(highlights, [{ pitch: 60, role: 'held', weight: 1, label: 'C' }]);
  assert.equal(readout.message, '');
  assert.equal(readout.lesson, null);
});
