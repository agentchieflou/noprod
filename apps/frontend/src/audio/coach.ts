// The Keyboard Coach on the keyboard panel. One Coach (@noprod/theory) hears
// every note on the MIDI bus: MIDI devices, the computer keyboard and the
// on-screen keys. It lights up the keys to play next and says why. The
// mode, key and lesson are remembered between visits.

import { Coach, LESSONS, findLesson, spellInKey, type CoachMode, type CoachReadout, type Highlight, type Key } from '@noprod/theory';
import { onMidiEvent } from './inputs';
import { subscribeKeyboard, getKeyboardState } from './computerKeyboard';

export interface CoachState {
  open: boolean;         // shown on the keyboard panel
  mode: CoachMode;
  key: Key | 'auto';
  lesson: string | null;
  focus: number | null;  // a suggestion pointed at in the readout: only its keys light
  highlights: Highlight[];
  readout: CoachReadout;
}

const STORAGE_KEY = 'noprod-coach';
const MODES: CoachMode[] = ['off', 'chords', 'melody', 'complement', 'lesson'];

type Saved = Pick<CoachState, 'mode' | 'key' | 'lesson'>;

// What was chosen last time, ignoring anything that no longer makes sense
function load(): Saved {
  const saved: Saved = { mode: 'chords', key: 'auto', lesson: null };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (MODES.includes(raw.mode)) saved.mode = raw.mode;
    const k = raw.key;
    if (k && Number.isInteger(k.tonic) && k.tonic >= 0 && k.tonic < 12 && (k.mode === 'major' || k.mode === 'minor')) saved.key = { tonic: k.tonic, mode: k.mode };
    if (typeof raw.lesson === 'string' && findLesson(raw.lesson)) saved.lesson = raw.lesson;
  } catch { /* no storage, or not ours */ }
  return saved;
}

const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: state.mode, key: state.key, lesson: state.lesson }));
  } catch { /* storage unavailable: the choice lasts this visit */ }
};

// The keys the piano shows: 32 semitones from the Z row's C
const pianoRange = (octave: number): [number, number] => [(octave + 1) * 12, (octave + 1) * 12 + 31];

const saved = load();
let rangeOctave = getKeyboardState().octave;
const coach = new Coach({ mode: saved.mode, key: saved.key, range: pianoRange(rangeOctave) });
coach.setLesson(saved.lesson);

let state: CoachState = { open: false, ...saved, focus: null, ...coach.suggest() };
const listeners = new Set<() => void>();
const set = (patch: Partial<CoachState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
export const subscribeCoach = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getCoachState = () => state;

// Notes arrive in bursts (a chord is several note-ons at once): suggest once
let pending = false;
const refresh = () => {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    const next = coach.suggest();
    // The suggestion pointed at may be gone (its chip with it)
    const focus = state.focus !== null && state.focus < next.readout.suggestions.length ? state.focus : null;
    set({ ...next, focus });
  });
};

export const setCoachOpen = (open: boolean) => { set({ open }); refresh(); };
export const setCoachMode = (mode: CoachMode) => { coach.setMode(mode); set({ mode, focus: null }); save(); refresh(); };
export const setCoachKey = (key: Key | 'auto') => { coach.setKey(key); set({ key }); save(); refresh(); };
export const setCoachLesson = (lesson: string | null) => { coach.setLesson(lesson); set({ lesson }); save(); refresh(); };
export const restartLesson = () => { coach.setLesson(state.lesson); refresh(); };
export const setCoachFocus = (focus: number | null) => set({ focus });

export const LESSON_GROUPS = [
  { label: 'Chords', lessons: LESSONS.filter((l) => l.kind === 'chords') },
  { label: 'Melodies', lessons: LESSONS.filter((l) => l.kind === 'melody') }
];

export interface KeyMark {
  role: 'next' | 'complement' | 'target' | 'wrong';
  glow: number;    // 0..1, relative to the strongest suggestion
  label?: string;
}
const RANK = { next: 1, complement: 1, target: 2, wrong: 3 };

// One mark per key: a wrong note over a lesson target over a suggestion; a
// key in several suggestions glows as the likeliest of them. With a focus,
// only that suggestion's keys. Also every note held, from any source (the
// panel itself only knows the computer keyboard's).

export function keyMarks(highlights: Highlight[], key: Key, focus: number | null = null) {
  const marks = new Map<number, KeyMark>();
  const held = new Set<number>();
  const strongest = Math.max(0, ...highlights.filter((h) => h.role === 'next' || h.role === 'complement').map((h) => h.weight));
  for (const h of highlights) {
    if (focus !== null && h.group !== undefined && h.group !== focus) continue;
    if (h.role === 'held' || h.role === 'wrong') held.add(h.pitch);
    if (h.role === 'held') continue;
    const glow = (h.role === 'next' || h.role === 'complement') && strongest > 0 ? h.weight / strongest : 1;
    // Lesson keys are named note by note ('G (V)' on the lowest would say G on a B)
    const label = h.role === 'target' ? spellInKey(h.pitch, key) : h.label;
    const mark = marks.get(h.pitch);
    if (!mark || RANK[h.role] > RANK[mark.role] || (RANK[h.role] === RANK[mark.role] && glow > mark.glow)) {
      marks.set(h.pitch, { role: h.role, glow, label: label ?? mark?.label });
    } else if (!mark.label && label) {
      mark.label = label;
    }
  }
  return { marks, held };
}

// The theory engine writes Bb and bVII; the panel shows B♭ and ♭VII
export const pretty = (text: string) => text
  .replace(/\b([A-G])b/g, '$1♭')
  .replace(/\b([A-G])#/g, '$1♯')
  .replace(/\bb(?=[IV])/g, '♭')
  .replace(/#(?=[IViv])/g, '♯');

export function initCoach() {
  // Note-ons only count while the coach is showing; note-offs always, so
  // nothing is left held
  onMidiEvent((e) => {
    const time = performance.now() / 1000;
    if (e.type === 'on') {
      if (!state.open) return;
      coach.noteOn(e.pitch, time, e.velocity);
    } else {
      coach.noteOff(e.pitch, time);
    }
    if (state.open) refresh();
  });
  // Suggestions stay on the keys the panel shows
  subscribeKeyboard(() => {
    const { octave } = getKeyboardState();
    if (octave === rangeOctave) return;
    rangeOctave = octave;
    coach.setRange(pianoRange(octave));
    refresh();
  });
}
