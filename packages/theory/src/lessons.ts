// Lessons: chord progressions and melodies to play step by step. A step is
// passed by holding all of its notes; any octave counts unless a step says
// otherwise.

import { chordNameInKey, parseNumeral, romanNumeral } from './chords.ts';
import { MELODIES, melodyPitches } from './melody.ts';
import { pc } from './notes.ts';
import { spellInKey, type Key } from './scales.ts';
import { voiceLead } from './voicing.ts';

export interface LessonStep {
  pitches: number[];
  label: string;
  anyOctave?: boolean;   // default true: the right pitch classes in any octave
}

export interface Lesson {
  id: string;
  name: string;
  kind: 'chords' | 'melody';
  key: Key;
  description: string;
  steps: LessonStep[];
}

// Chord lessons stay around middle C: F3 to G5
const CHORD_RANGE: [number, number] = [53, 79];

export const noteNameInKey = (pitch: number, key: Key) => spellInKey(pitch, key) + (Math.floor(pitch / 12) - 1);

// Each chord voiced from the one before, so the hands barely move
function chordLesson(id: string, name: string, key: Key, numerals: string[], description: string): Lesson {
  let from: number[] = [];
  const steps = numerals.map(numeral => {
    const { root, quality } = parseNumeral(numeral, key);
    const pitches = voiceLead(from, root, quality, CHORD_RANGE);
    from = pitches;
    return { pitches, label: `${chordNameInKey(root, quality, key)} (${romanNumeral(root, quality, key)})` };
  });
  return { id, name, kind: 'chords', key, description, steps };
}

function melodyLesson(id: string, description: string): Lesson {
  const melody = MELODIES.find(m => m.id === id)!;
  const steps = melodyPitches(melody).map(p => ({ pitches: [p], label: noteNameInKey(p, melody.key) }));
  return { id, name: melody.name, kind: 'melody', key: melody.key, description, steps };
}

const C_MAJOR: Key = { tonic: 0, mode: 'major' };

export const LESSONS: Lesson[] = [
  chordLesson('pop-c', 'I–V–vi–IV in C', C_MAJOR, ['I', 'V', 'vi', 'IV'],
    'The four chords behind countless pop songs. Keep the common notes held and move the rest.'),
  chordLesson('ii-v-i-c', 'ii–V–I in C', C_MAJOR, ['ii7', 'V7', 'Imaj7'],
    "Jazz's basic cadence, with 7th chords: each chord slides into the next by a step or less."),
  chordLesson('blues-a', '12-bar blues in A', { tonic: 9, mode: 'major' },
    ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'],
    'Twelve bars of dominant 7ths: four on A, two on D, two on A, then E, D, A and E to turn around.'),
  chordLesson('pachelbel-d', 'Pachelbel in D', { tonic: 2, mode: 'major' }, ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
    'The eight chords under the Canon in D, each voiced close to the last.'),
  chordLesson('minor-am', 'i–VI–III–VII in A minor', { tonic: 9, mode: 'minor' }, ['i', 'VI', 'III', 'VII'],
    'A minor-key loop heard all over rock and pop: Am, F, C, G.'),
  melodyLesson('twinkle', 'A nursery tune in C: a leap up to G, then repeated notes stepping back down.'),
  melodyLesson('ode-to-joy', "Beethoven's theme in C: almost all steps, with a drop to low G before the last line."),
  melodyLesson('frere-jacques', 'The round in C: short phrases, each played twice.'),
  melodyLesson('mary', 'Four notes in C: E, D, C and back, with a jump up to G.'),
  melodyLesson('amazing-grace', 'The hymn tune in G, in waltz time: wider leaps up to the high D.'),
  melodyLesson('greensleeves', 'The 16th-century tune in A minor, with the raised G# leading home to A.')
];

export const findLesson = (id: string) => LESSONS.find(lesson => lesson.id === id) ?? null;

export type LessonResult = 'advance' | 'partial' | 'wrong' | 'done';

// Follows a lesson as notes are pressed: hand it everything held after
// each note-on
export class LessonRunner {
  readonly lesson: Lesson;
  private index = 0;

  constructor(lesson: Lesson) {
    this.lesson = lesson;
  }

  step() {
    return this.index;
  }

  current(): LessonStep | null {
    return this.lesson.steps[this.index] ?? null;
  }

  done() {
    return this.index >= this.lesson.steps.length;
  }

  // 'wrong' when a held note isn't in the step (it doesn't advance);
  // 'partial' while some of the step's notes are still missing; 'advance'
  // once all are held, 'done' after the last step
  press(held: number[]): LessonResult {
    const step = this.current();
    if (!step) return 'done';
    const same = (step.anyOctave ?? true) ? pc : (p: number) => p;
    const target = new Set(step.pitches.map(same));
    const pressed = new Set(held.map(same));
    if ([...pressed].some(p => !target.has(p))) return 'wrong';
    if ([...target].some(p => !pressed.has(p))) return 'partial';
    this.index++;
    return this.done() ? 'done' : 'advance';
  }

  restart() {
    this.index = 0;
  }
}
