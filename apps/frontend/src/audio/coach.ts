// The Keyboard Coach on the keyboard panel. One Coach (@noprod/theory) hears
// every note on the MIDI bus: MIDI devices, the computer keyboard and the
// on-screen keys. It lights up the keys to play next and says why. The
// mode, key and lesson are remembered between visits.

import {
  Coach, LESSONS, PROGRESSIONS, findLesson, lessonFromNotes, parseNumeral, spellInKey, voiceLead,
  type ChordQuality, type CoachMode, type CoachReadout, type Highlight, type Key, type Lesson
} from '@noprod/theory';
import { v4 as uuidv4 } from 'uuid';
import { onMidiEvent } from './inputs';
import { getPosition } from './transport';
import { barAt, barsUntil, type TimeSig } from './timeline';
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
    // A lesson made from a clip (CLIP_LESSON) isn't in LESSONS, so it isn't
    // found here: after a reload the picker shows no lesson
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
// The picker's value for the lesson made from a clip, which isn't in LESSONS
export const CLIP_LESSON = 'clip';
// The picker entry that makes one; the select never holds it
export const CLIP_PICK = 'clip-pick';
let clipLesson: Lesson | null = null;
export const getClipLesson = () => clipLesson;

export const setCoachLesson = (lesson: string | null) => { coach.setLesson(lesson); set({ lesson }); save(); refresh(); };
export const setCoachLessonFromNotes = (notes: { pitch: number; start: number; duration: number }[], name: string) => {
  clipLesson = lessonFromNotes(notes, name);
  coach.setLesson(clipLesson);
  set({ lesson: CLIP_LESSON });
  save();
  refresh();
};
export const restartLesson = () => { coach.setLesson(state.lesson === CLIP_LESSON ? clipLesson : state.lesson); refresh(); };
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

// ------------------------------------------------------- write to a clip

export type ClipSource = { kind: 'played' } | { kind: 'progression'; name: string };
export interface ClipChord { root: number; quality: ChordQuality }
export interface ClipNote { id: string; pitch: number; start: number; duration: number; velocity: number }

const CLIP_RANGE: [number, number] = [48, 72];   // C3–C5
const CLIP_VELOCITY = 0.8;

// The progressions that fit a key's mode
export const progressionsFor = (key: Key) => PROGRESSIONS.filter((p) => p.mode === key.mode);

// The chords a source stands for, in the coach's key
export function sourceChords(source: ClipSource, key: Key): ClipChord[] {
  if (source.kind === 'played') return coach.recentChords();
  const progression = progressionsFor(key).find((p) => p.name === source.name);
  return progression ? progression.numerals.map((n) => parseNumeral(n, key)) : [];
}

// One bar per chord from `start` (a bar line, seconds), each voiced close
// to the one before; notes are held for the bar, with the root an octave
// below the lowest note when `bass`. Times are relative to the clip.
export function buildClipNotes(chords: ClipChord[], start: number, bpm: number, sigs: TimeSig[], bass = true) {
  const bars = barsUntil(bpm, start + (chords.length + 1) * 16 * 60 / bpm, sigs);
  const first = bars.findIndex((b) => Math.abs(b.time - start) < 1e-6);
  const notes: ClipNote[] = [];
  let voicing: number[] = [];
  let duration = 0;
  chords.forEach((chord, i) => {
    const bar = bars[first + i];
    voicing = voiceLead(voicing, chord.root, chord.quality, CLIP_RANGE);
    // The root nearest an octave below the lowest note, never above that
    const ceiling = voicing[0] - 12;
    const pitches = bass ? [ceiling - (((ceiling - chord.root) % 12) + 12) % 12, ...voicing] : voicing;
    pitches.forEach((pitch) => notes.push({
      id: uuidv4(), pitch, start: bar.time - start, duration: bar.length, velocity: CLIP_VELOCITY
    }));
    duration = bar.time - start + bar.length;
  });
  return { notes, duration };
}

// Why the control can't write, or null when it can
export function clipBlocker(source: ClipSource | null): string | null {
  const state = store.getState();
  const track = state.tracks?.find((t: any) => t.id === state.selectedTrackId);
  if (!track || track.type !== 'midi') return 'Select a MIDI track to write to';
  if (!source) return 'Pick a progression to write';
  if (!sourceChords(source, coach.key()).length) return source.kind === 'played' ? 'Play some chords first' : 'Pick a progression to write';
  return null;
}

// Writes the source's chords as a clip on the selected MIDI track, from
// the bar under the playhead. One undo step.
export function writeChordsToClip(source: ClipSource, bass = true): boolean {
  if (clipBlocker(source)) return false;
  const state = store.getState();
  const chords = sourceChords(source, coach.key()).slice(source.kind === 'played' ? -8 : undefined);
  const start = barAt(state.bpm, Math.max(0, getPosition()), state.timeSignatures).time;
  const { notes, duration } = buildClipNotes(chords, start, state.bpm, state.timeSignatures, bass);
  state.addMidiRegion(state.selectedTrackId, start, duration, notes);
  return true;
}

interface Store { getState: () => any }
let store: Store = { getState: () => ({}) };

export function initCoach(s: Store) {
  store = s;
  // Note-ons only count while the coach is showing; note-offs always, so
  // nothing is left held
  onMidiEvent((e) => {
    const time = performance.now() / 1000;
    if (e.type === 'on') {
      if (!state.open) return;
      coach.noteOn(e.pitch, time, e.velocity);
    } else if (e.type === 'off') {
      coach.noteOff(e.pitch, time);
    } else {
      return;
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
