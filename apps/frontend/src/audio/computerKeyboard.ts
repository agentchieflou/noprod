// The computer keyboard as a MIDI keyboard, designed to be obvious rather
// than to copy Ableton:
// - Piano mode: two piano-shaped rows like trackers and FL Studio. The Z row
//   is the white keys of the lower octave with the S row as its black keys;
//   the Q row is the white keys an octave up with the number row as black
//   keys. That's 2.5 octaves, and the shape matches a real keyboard.
// - Scale mode: every white-key position plays the next note of the chosen
//   key and scale (no wrong notes), optionally as a full chord.
// - Drums mode (automatic on a drum kit): keys are named drum pads.
// Keys are matched by physical position (KeyboardEvent.code), so the layout
// is the same on QWERTY, AZERTY or QWERTZ. ←/→ change octave, ↑/↓ velocity,
// Shift plays accents, Esc silences everything. Notes go to the selected
// MIDI track (no arming needed), or to armed MIDI tracks if none is selected.

import { audioContext } from './engine';
import { publishMidi } from './inputs';
import { isLibraryKit } from './library';

export type KeyboardMode = 'auto' | 'piano' | 'scale' | 'drums';

export const SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10]
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINORISH = ['Minor', 'Dorian', 'Harmonic Minor', 'Minor Pentatonic', 'Blues'];

// Spell notes the way the key is written: flats in F, B♭, E♭... major and
// D, G, C, F... minor, sharps otherwise
export function usesFlats(root: number, scale: string) {
  const flatRoots = MINORISH.includes(scale) ? [2, 7, 0, 5, 10, 3] : [5, 10, 3, 8, 1];
  return flatRoots.includes(root);
}
export const spellNote = (pitchClass: number, flats: boolean) => (flats ? FLAT_NAMES : NOTE_NAMES)[((pitchClass % 12) + 12) % 12];

// Piano mode: semitone offsets from the base C
export const PIANO_LOWER: [string, number][] = [
  ['KeyZ', 0], ['KeyS', 1], ['KeyX', 2], ['KeyD', 3], ['KeyC', 4], ['KeyV', 5], ['KeyG', 6], ['KeyB', 7],
  ['KeyH', 8], ['KeyN', 9], ['KeyJ', 10], ['KeyM', 11], ['Comma', 12], ['KeyL', 13], ['Period', 14], ['Semicolon', 15], ['Slash', 16]
];
export const PIANO_UPPER: [string, number][] = [
  ['KeyQ', 12], ['Digit2', 13], ['KeyW', 14], ['Digit3', 15], ['KeyE', 16], ['KeyR', 17], ['Digit5', 18], ['KeyT', 19],
  ['Digit6', 20], ['KeyY', 21], ['Digit7', 22], ['KeyU', 23], ['KeyI', 24], ['Digit9', 25], ['KeyO', 26], ['Digit0', 27],
  ['KeyP', 28], ['BracketLeft', 29], ['Equal', 30], ['BracketRight', 31]
];
// Scale mode: white-key positions play consecutive scale degrees; the Q row
// starts one octave (one full scale) above the Z row
export const SCALE_LOWER = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];
export const SCALE_UPPER = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'];
// Drums mode: one pad per white-key position, same pads on both rows
export const DRUM_PADS: { note: number; name: string }[] = [
  { note: 36, name: 'Kick' }, { note: 38, name: 'Snare' }, { note: 39, name: 'Clap' }, { note: 42, name: 'Closed Hat' },
  { note: 46, name: 'Open Hat' }, { note: 45, name: 'Low Tom' }, { note: 48, name: 'High Tom' }, { note: 49, name: 'Crash' }
];

// QWERTY labels, replaced by the real layout where the browser exposes it
const QWERTY: Record<string, string> = {
  KeyZ: 'Z', KeyS: 'S', KeyX: 'X', KeyD: 'D', KeyC: 'C', KeyV: 'V', KeyG: 'G', KeyB: 'B', KeyH: 'H', KeyN: 'N', KeyJ: 'J',
  KeyM: 'M', Comma: ',', KeyL: 'L', Period: '.', Semicolon: ';', Slash: '/', KeyQ: 'Q', Digit2: '2', KeyW: 'W', Digit3: '3',
  KeyE: 'E', KeyR: 'R', Digit5: '5', KeyT: 'T', Digit6: '6', KeyY: 'Y', Digit7: '7', KeyU: 'U', KeyI: 'I', Digit9: '9',
  KeyO: 'O', Digit0: '0', KeyP: 'P', BracketLeft: '[', Equal: '=', BracketRight: ']'
};
let labels: Record<string, string> = { ...QWERTY };
export const keyLabel = (code: string) => labels[code] || QWERTY[code] || '';

export interface KeyboardState {
  enabled: boolean;
  octave: number;        // octave of the Z row's C (C3 = 3)
  velocity: number;      // 0.05..1
  mode: KeyboardMode;
  root: number;          // scale mode: 0 = C
  scale: string;
  chords: boolean;       // scale mode: each key plays a triad
  sounding: number[];    // pitches currently held (for the on-screen keys)
  pressedCodes: string[];
  targetName: string | null;
}

let state: KeyboardState = {
  enabled: false, octave: 3, velocity: 0.8, mode: 'auto', root: 0, scale: 'Minor', chords: false,
  sounding: [], pressedCodes: [], targetName: null
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (patch: Partial<KeyboardState>) => { state = { ...state, ...patch }; emit(); };
export const subscribeKeyboard = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getKeyboardState = () => state;

let getStore: () => any = () => ({});
const held = new Map<string, number[]>(); // key code (or 'pointer:<id>') -> pitches it started

// Where the keyboard plays: the selected MIDI track, else armed MIDI tracks
export function keyboardTarget(st: any): { ids: string[] | undefined; track: any | null } {
  const sel = (st.tracks || []).find((t: any) => t.id === st.selectedTrackId && t.type === 'midi');
  if (sel) return { ids: [sel.id], track: sel };
  const armed = (st.tracks || []).find((t: any) => t.type === 'midi' && t.isArmed);
  return { ids: undefined, track: armed || null };
}

// The mode actually in use: Auto means Drums on a drum kit, Piano otherwise
export function effectiveMode(st: any): Exclude<KeyboardMode, 'auto'> {
  if (state.mode !== 'auto') return state.mode;
  const params = keyboardTarget(st).track?.instrument?.parameters;
  return params?.Kit === 'drums' || isLibraryKit(params) ? 'drums' : 'piano';
}

const scaleDegreePitch = (degree: number) => {
  const steps = SCALES[state.scale] || SCALES.Major;
  const base = (state.octave + 1) * 12 + state.root;
  return base + 12 * Math.floor(degree / steps.length) + steps[((degree % steps.length) + steps.length) % steps.length];
};

// Pitches a key plays in the current mode (null = key not used)
export function pitchesForCode(code: string, mode: Exclude<KeyboardMode, 'auto'>): number[] | null {
  if (mode === 'drums') {
    const i = SCALE_LOWER.indexOf(code) >= 0 ? SCALE_LOWER.indexOf(code) : SCALE_UPPER.indexOf(code);
    return i >= 0 && i < DRUM_PADS.length ? [DRUM_PADS[i].note] : null;
  }
  if (mode === 'scale') {
    const n = (SCALES[state.scale] || SCALES.Major).length;
    const lo = SCALE_LOWER.indexOf(code), hi = SCALE_UPPER.indexOf(code);
    const degree = lo >= 0 ? lo : hi >= 0 ? hi + n : -1;
    if (degree < 0) return null;
    return state.chords ? [degree, degree + 2, degree + 4].map(scaleDegreePitch) : [scaleDegreePitch(degree)];
  }
  const entry = PIANO_LOWER.find(([c]) => c === code) || PIANO_UPPER.find(([c]) => c === code);
  return entry ? [(state.octave + 1) * 12 + entry[1]] : null;
}

const refreshSounding = () => {
  const sounding = [...new Set([...held.values()].flat())];
  set({ sounding, pressedCodes: [...held.keys()] });
};

// Start notes for a key / on-screen pad (id identifies it until release)
export function press(id: string, pitches: number[], velocity = state.velocity) {
  if (held.has(id)) return;
  const st = getStore();
  const target = keyboardTarget(st);
  if (audioContext.state === 'suspended') audioContext.resume();
  const now = audioContext.currentTime;
  pitches.filter((p) => p >= 0 && p <= 127).forEach((pitch) =>
    publishMidi({ type: 'on', pitch, velocity, channel: 1, source: 'computer', time: now, targets: target.ids }));
  held.set(id, pitches);
  refreshSounding();
}

export function release(id: string) {
  const pitches = held.get(id);
  if (!pitches) return;
  held.delete(id);
  const st = getStore();
  const target = keyboardTarget(st);
  const now = audioContext.currentTime;
  pitches.forEach((pitch) => {
    // another held key may still be sounding this pitch (e.g. overlapping chords)
    if ([...held.values()].some((ps) => ps.includes(pitch))) return;
    publishMidi({ type: 'off', pitch, velocity: 0, channel: 1, source: 'computer', time: now, targets: target.ids });
  });
  refreshSounding();
}

export function releaseAll() {
  [...held.keys()].forEach(release);
}

export const setKeyboardEnabled = (enabled: boolean) => {
  if (!enabled) releaseAll();
  set({ enabled });
};
export const setOctave = (octave: number) => { releaseAll(); set({ octave: Math.max(0, Math.min(7, octave)) }); };
export const setVelocity = (velocity: number) => set({ velocity: Math.max(0.05, Math.min(1, Math.round(velocity * 100) / 100)) });
export const setKeyboardMode = (mode: KeyboardMode) => { releaseAll(); set({ mode }); };
export const setScale = (patch: Partial<Pick<KeyboardState, 'root' | 'scale' | 'chords'>>) => { releaseAll(); set(patch); };

// Typing in a field, or a plugin editor that has the keyboard
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
    || !!t.closest?.('[data-keyboard-capture]');
};

export function initComputerKeyboard(store: { getState: () => any; subscribe: (fn: (s: any) => void) => unknown }) {
  getStore = store.getState;
  // Show which track is being played
  const updateTarget = (st: any) => {
    const name = keyboardTarget(st).track?.name ?? null;
    if (name !== state.targetName) set({ targetName: name });
  };
  updateTarget(store.getState());
  store.subscribe(updateTarget);

  (navigator as any).keyboard?.getLayoutMap?.().then((map: Map<string, string>) => {
    const next: Record<string, string> = {};
    Object.keys(QWERTY).forEach((code) => { const ch = map.get(code); if (ch) next[code] = ch.toUpperCase(); });
    labels = { ...QWERTY, ...next };
    emit();
  }).catch(() => { /* not exposed: QWERTY labels */ });

  window.addEventListener('keydown', (e) => {
    if (!state.enabled || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (e.code === 'Escape') { releaseAll(); return; }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      if (!e.repeat) setOctave(state.octave + (e.code === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      setVelocity(state.velocity + (e.code === 'ArrowUp' ? 0.1 : -0.1));
      return;
    }
    if (e.repeat) return;
    const pitches = pitchesForCode(e.code, effectiveMode(store.getState()));
    if (!pitches) return;
    e.preventDefault();
    press(e.code, pitches, e.shiftKey ? 1 : state.velocity); // Shift = accent
  });

  window.addEventListener('keyup', (e) => release(e.code));
  // Losing focus (alt-tab) would otherwise leave notes hanging
  window.addEventListener('blur', releaseAll);
}
