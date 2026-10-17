import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LESSONS, LessonRunner, chordNameInKey, findLesson, lessonFromNotes, movement, recognizeChord, type Lesson
} from '../src/index.ts';

test('every lesson has steps, in range, with labels', () => {
  assert.equal(new Set(LESSONS.map(l => l.id)).size, LESSONS.length);
  assert.equal(LESSONS.filter(l => l.kind === 'chords').length, 5);
  assert.equal(LESSONS.filter(l => l.kind === 'melody').length, 6);
  for (const lesson of LESSONS) {
    assert.ok(lesson.steps.length > 0 && lesson.description.length > 0, lesson.id);
    for (const step of lesson.steps) {
      assert.ok(step.pitches.length > 0 && step.label.length > 0, lesson.id);
      for (const p of step.pitches) assert.ok(p >= 48 && p <= 84, `${lesson.id}: ${p}`);
    }
  }
});

test('chord lessons play the chords they name, with smooth voice leading around C4', () => {
  for (const lesson of LESSONS.filter(l => l.kind === 'chords')) {
    lesson.steps.forEach((step, i) => {
      const chord = recognizeChord(step.pitches, lesson.key);
      assert.ok(chord, `${lesson.id} step ${i}`);
      assert.ok(step.label.startsWith(`${chordNameInKey(chord.root, chord.quality, lesson.key)} (`), `${lesson.id}: ${step.label}`);
      const center = step.pitches.reduce((s, p) => s + p, 0) / step.pitches.length;
      assert.ok(Math.abs(center - 64) <= 9, `${lesson.id} step ${i} centered at ${center}`);
      if (i > 0) assert.ok(movement(lesson.steps[i - 1].pitches, step.pitches) <= 8, `${lesson.id} step ${i}`);
    });
  }
  assert.deepEqual(findLesson('pop-c')!.steps.map(s => s.label), ['C (I)', 'G (V)', 'Am (vi)', 'F (IV)']);
  assert.deepEqual(findLesson('ii-v-i-c')!.steps.map(s => s.label), ['Dm7 (ii7)', 'G7 (V7)', 'Cmaj7 (Imaj7)']);
  assert.equal(findLesson('blues-a')!.steps.length, 12);
  assert.ok(findLesson('blues-a')!.steps.every(s => s.label.includes('7')));
  assert.deepEqual(findLesson('minor-am')!.steps.map(s => s.label), ['Am (i)', 'F (VI)', 'C (III)', 'G (VII)']);
});

test('melody lessons are single notes labeled with their names', () => {
  const twinkle = findLesson('twinkle')!;
  assert.deepEqual(twinkle.steps.slice(0, 7).map(s => s.label), ['C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4']);
  assert.ok(findLesson('greensleeves')!.steps.some(s => s.label === 'G#4'));
  for (const lesson of LESSONS.filter(l => l.kind === 'melody')) {
    for (const step of lesson.steps) assert.equal(step.pitches.length, 1);
  }
});

test('a chord step passes with its notes in any voicing or octave', () => {
  const runner = new LessonRunner(findLesson('pop-c')!);
  assert.equal(runner.step(), 0);
  assert.equal(runner.press([60, 64]), 'partial');
  assert.equal(runner.press([48, 64, 67, 72]), 'advance');
  assert.equal(runner.step(), 1);
  // G as G B D, two octaves down
  assert.equal(runner.press([43]), 'partial');
  assert.equal(runner.press([43, 47]), 'partial');
  assert.equal(runner.press([43, 47, 50]), 'advance');
  // A wrong note doesn't advance
  assert.equal(runner.press([61]), 'wrong');
  assert.equal(runner.press([57, 60, 61, 64]), 'wrong');
  assert.equal(runner.step(), 2);
  assert.equal(runner.press([69, 72, 76]), 'advance');
  assert.equal(runner.done(), false);
  assert.equal(runner.press([65, 69, 72]), 'done');
  assert.equal(runner.done(), true);
  assert.equal(runner.current(), null);
  assert.equal(runner.press([60]), 'done');
  runner.restart();
  assert.equal(runner.step(), 0);
  assert.deepEqual(runner.current(), findLesson('pop-c')!.steps[0]);
});

test('a melody step passes on its note, in any octave unless the step says not', () => {
  const runner = new LessonRunner(findLesson('mary')!);
  assert.equal(runner.press([64]), 'advance');
  assert.equal(runner.press([74]), 'advance');   // D, an octave up
  assert.equal(runner.press([61]), 'wrong');
  assert.equal(runner.step(), 2);

  const exact: Lesson = {
    id: 'exact', name: 'Exact', kind: 'melody', key: { tonic: 0, mode: 'major' }, description: 'Exact octaves',
    steps: [{ pitches: [60], label: 'C4', anyOctave: false }, { pitches: [62], label: 'D4', anyOctave: false }]
  };
  const strict = new LessonRunner(exact);
  assert.equal(strict.press([72]), 'wrong');
  assert.equal(strict.press([60]), 'advance');
  assert.equal(strict.press([62]), 'done');
});

test('a clip of single notes is a melody lesson', () => {
  const pitches = [60, 64, 67, 64, 60, 62, 64, 60];
  const notes = pitches.map((pitch, i) => ({ pitch, start: i * 0.5, duration: 0.5 }));
  const lesson = lessonFromNotes(notes, 'Scale');
  assert.equal(lesson.kind, 'melody');
  assert.equal(lesson.name, 'Scale');
  assert.deepEqual(lesson.key, { tonic: 0, mode: 'major' });
  assert.deepEqual(lesson.steps.map(s => s.label), ['C4', 'E4', 'G4', 'E4', 'C4', 'D4', 'E4', 'C4']);
  assert.deepEqual(lesson.steps.map(s => s.pitches), pitches.map(p => [p]));
});

test('a clip of block chords is a chord lesson, with a lone note between a melody step', () => {
  const chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];
  const notes = chords.flatMap((c, i) => c.map(pitch => ({ pitch, start: i * 2 + (pitch % 3) * 0.01, duration: 2 })));
  const lesson = lessonFromNotes(notes, 'Pop');
  assert.equal(lesson.kind, 'chords');
  assert.deepEqual(lesson.steps.map(s => s.label), ['C (I)', 'G (V)', 'Am (vi)', 'F (IV)']);
  for (const [i, step] of lesson.steps.entries()) {
    const chord = recognizeChord(step.pitches, lesson.key)!;
    assert.ok(step.label.startsWith(chordNameInKey(chord.root, chord.quality, lesson.key)));
    assert.deepEqual(step.pitches, chords[i]);
  }
  const mixed = lessonFromNotes([...notes, { pitch: 72, start: 8.5, duration: 0.5 }], 'Mixed');
  assert.deepEqual(mixed.steps.at(-1)!.pitches, [72]);
  assert.equal(mixed.steps.at(-1)!.label, 'C5');
  assert.equal(mixed.steps.length, 5);
});

test('lessonFromNotes is deterministic and runs', () => {
  const notes = [60, 64, 67].map(pitch => ({ pitch, start: 0, duration: 1 }));
  assert.deepEqual(lessonFromNotes(notes, 'x'), lessonFromNotes([...notes].reverse(), 'x'));
  const runner = new LessonRunner(lessonFromNotes(notes, 'x'));
  assert.equal(runner.press([60, 64, 67]), 'done');
});
