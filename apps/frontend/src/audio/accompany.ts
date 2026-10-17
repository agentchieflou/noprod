// The band behind the Keyboard Coach (#109): a bass line and a comping part
// that follow the chords you play, on two MIDI tracks of their own, so
// their strips, devices and sends apply. The Accompanist (@noprod/theory)
// decides every note in beats; this keeps it on the audio clock. Notes are
// committed a little ahead, and a chord change takes back the ones it
// undoes before they sound.
//
// Timing: a chord counts from MARGIN after it's played (what's sooner may
// already be rendering). Put down earlier than that before a step (a beat,
// half a bar… as the style says), it catches the step; up to LATE_GRACE
// after, the step is played again with it; later, it waits for the next.
// Turning Accompany on starts the transport; the band comes in at the
// first chord. It stops with the transport, and when the coach closes or
// leaves Chords mode.

import { Accompanist, ACCOMPANY_STYLES, findStyle, pitchClasses, type AccompanyEvent, type AccompanyStyle } from '@noprod/theory';
import { findSound } from '@noprod/sound';
import { audioContext, getStripInput } from './engine';
import { triggerNote } from './synth';
import { createLibraryInstrument, prewarmPending } from './library';
import { onMidiEvent } from './inputs';
import { getTransportSnapshot, onTransportChange } from './transport';
import { barAt } from './timeline';
import { getCoachState, subscribeCoach } from './coach';

const LOOKAHEAD = 0.2;   // seconds committed ahead
const TICK_MS = 25;
const MARGIN = 0.03;     // seconds
const CUT = 0.015;       // a cut note fades with this time constant

type Part = 'bass' | 'keys';
const PARTS: Part[] = ['bass', 'keys'];
export const BAND_TRACKS: Record<Part, string> = { bass: 'Band Bass', keys: 'Band Keys' };
const SOUNDS: Record<Part, string> = { bass: 'bass-finger', keys: 'piano-electric' };
const RANGES: Record<Part, [number, number]> = { bass: [28, 55], keys: [52, 76] };

export interface AccompanyState {
  on: boolean;
  style: string;
}

interface Store { getState: () => any }

const STORAGE_KEY = 'noprod-accompany';

const loadStyle = () => {
  try {
    const id = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').style;
    if (findStyle(id)) return id as string;
  } catch { /* no storage, or not ours */ }
  return ACCOMPANY_STYLES[0].id;
};

let state: AccompanyState = { on: false, style: loadStyle() };
const listeners = new Set<() => void>();
const set = (patch: Partial<AccompanyState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
export const subscribeAccompany = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getAccompanyState = () => state;
const style = (): AccompanyStyle => findStyle(state.style) ?? ACCOMPANY_STYLES[0];

let store: Store = { getState: () => ({}) };

// ------------------------------------------------------------------ clock

// Beats on the transport's bar grid, running on from where it was when the
// band started (loops don't move it)
interface Clock { ctx: number; beat: number; bpm: number; beatsPerBar: number }

const beatOf = (c: Clock, time: number) => c.beat + ((time - c.ctx) * c.bpm) / 60;
const timeOf = (c: Clock, beat: number) => c.ctx + ((beat - c.beat) * 60) / c.bpm;

function transportClock(): Clock | null {
  const snap = getTransportSnapshot();
  if (!snap.playing || !snap.segments.length) return null;
  const now = audioContext.currentTime;
  const seg = [...snap.segments].reverse().find((s) => s.ctxStart <= now) ?? snap.segments[0];
  const bar = barAt(snap.bpm, Math.max(0, seg.posStart), store.getState().timeSignatures);
  const beatsPerBar = (bar.numerator * 4) / bar.denominator;
  return { ctx: seg.ctxStart, beat: bar.index * beatsPerBar + ((seg.posStart - bar.time) * snap.bpm) / 60, bpm: snap.bpm, beatsPerBar };
}

// Same tempo and grid, within a few milliseconds (a reschedule shifts the
// transport by its start delay)
const sameClock = (a: Clock, b: Clock) => a.bpm === b.bpm && a.beatsPerBar === b.beatsPerBar
  && Math.abs(beatOf(a, audioContext.currentTime) - beatOf(b, audioContext.currentTime)) * (60 / a.bpm) < 0.05;

// ------------------------------------------------------------------- band

interface Sounding { src: { stop: (when?: number) => void }; gain: GainNode; start: number; end: number }
export interface PlayedNote { id: number; part: Part; pitch: number; start: number; end: number; track: string }

interface Band { acc: Accompanist; clock: Clock; notes: Map<number, Sounding>; timer: ReturnType<typeof setInterval> }
let band: Band | null = null;
const held = new Set<number>();
let lastChord: number[] = [];   // the notes of the chord last put down
const played: PlayedNote[] = [];   // what the band played lately, for tests and meters

const bandTrack = (part: Part) =>
  (store.getState().tracks || []).find((t: any) => t.type === 'midi' && t.name === BAND_TRACKS[part]);

function cut(note: Sounding, at: number) {
  note.gain.gain.setTargetAtTime(0, at, CUT);
  try { note.src.stop(at + CUT * 8); } catch { /* already stopped */ }
  note.end = Math.min(note.end, at);
}

function apply(events: AccompanyEvent[]) {
  if (!band) return;
  const { clock, notes } = band;
  const now = audioContext.currentTime;
  for (const e of events) {
    if (e.type === 'start') {
      const { note } = e;
      const track = bandTrack(note.part);
      const start = timeOf(clock, note.start), end = timeOf(clock, note.end);
      // Its track gone, or the scheduler fell behind it
      if (!track?.instrument || start < now - 0.05) continue;
      const gain = audioContext.createGain();
      gain.connect(getStripInput(track.id));
      const src = triggerNote(audioContext, gain, track.instrument.parameters, note.pitch, Math.max(start, now), end - start, note.velocity);
      notes.set(note.id, { src, gain, start, end });
      played.push({ id: note.id, part: note.part, pitch: note.pitch, start, end, track: track.id });
      if (played.length > 2000) played.splice(0, played.length - 1000);
    } else {
      const note = notes.get(e.id);
      if (!note) continue;
      const at = timeOf(clock, e.at);
      if (at <= note.start + 1e-6) {
        // Taken back before it sounds
        note.gain.gain.value = 0;
        try { note.src.stop(note.start); } catch { /* already stopped */ }
        notes.delete(e.id);
      } else {
        cut(note, at);
      }
      const entry = played.slice().reverse().find((p) => p.id === e.id);
      if (entry) entry.end = Math.min(entry.end, Math.max(at, entry.start));
    }
  }
}

function tick() {
  if (!band) return;
  const now = audioContext.currentTime;
  apply(band.acc.advance(beatOf(band.clock, now), beatOf(band.clock, now + LOOKAHEAD)));
  for (const [id, note] of band.notes) if (note.end < now - 1) band.notes.delete(id);
}

function startBand(clock = transportClock()) {
  if (band || !clock || !state.on) return;
  const acc = new Accompanist(style(), { beatsPerBar: clock.beatsPerBar, bassRange: RANGES.bass, keysRange: RANGES.keys });
  // It goes on from the chord last put down
  const at = beatOf(clock, audioContext.currentTime + MARGIN);
  for (const p of lastChord) acc.noteOn(p, at);
  for (const p of lastChord) if (!held.has(p)) acc.noteOff(p);
  for (const p of held) if (!lastChord.includes(p)) acc.noteOn(p, at);
  band = { acc, clock, notes: new Map(), timer: setInterval(tick, TICK_MS) };
  tick();
}

function stopBand() {
  if (!band) return;
  const now = audioContext.currentTime;
  apply(band.acc.stop(beatOf(band.clock, now)));
  // Whatever's left (nothing, normally) stops too
  for (const note of band.notes.values()) if (note.end > now) cut(note, now);
  clearInterval(band.timer);
  band = null;
}

// ---------------------------------------------------------------- control

// The band's two tracks, made the first time (the track you play stays selected)
function ensureTracks() {
  const selected = store.getState().selectedTrackId;
  for (const part of PARTS) {
    const sound = findSound(SOUNDS[part]);
    if (!bandTrack(part) && sound) store.getState().addMidiTrackWithInstrument(createLibraryInstrument(sound), BAND_TRACKS[part]);
  }
  if (store.getState().selectedTrackId !== selected) store.getState().setSelectedTrackId(selected);
}

export function setAccompany(on: boolean) {
  if (on === state.on) return;
  set({ on });
  if (!on) {
    stopBand();
    lastChord = [];
    return;
  }
  ensureTracks();
  if (!store.getState().isPlaying) store.getState().togglePlayback();
  startBand();
}

export function setAccompanyStyle(id: string) {
  if (!findStyle(id) || id === state.style) return;
  set({ style: id });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: id })); } catch { /* storage unavailable */ }
  // The new style takes over at the next step
  if (band) { stopBand(); startBand(); }
}

// Every note the band may play in this style and tempo, as the library
// renders them: each hit's length, and what's left of it after each step
// it spans (where a chord change strikes it again)
export function accompanyWarmup(): { params: any; notes: { pitch: number; velocity: number; duration: number }[] }[] {
  if (!state.on) return [];
  const s = style();
  const beat = 60 / (store.getState().bpm || 120);
  return PARTS.flatMap((part) => {
    const track = bandTrack(part);
    if (!track?.instrument) return [];
    const kinds = new Map<string, { velocity: number; duration: number }>();
    for (const hit of s[part]) {
      for (let from = hit.at; from < hit.at + hit.length - 1e-9; from = (Math.floor(from / s.step + 1e-9) + 1) * s.step) {
        const duration = (hit.at + hit.length - from) * beat;
        kinds.set(`${hit.velocity}:${duration.toFixed(3)}`, { velocity: hit.velocity, duration });
      }
    }
    // From the middle of the range out: the likeliest first
    const [low, high] = RANGES[part];
    const middle = Math.round((low + high) / 2);
    const pitches = Array.from({ length: high - low + 1 }, (_, i) => middle + (i % 2 ? (i + 1) / 2 : -i / 2)).filter((p) => p >= low && p <= high);
    return [{ params: track.instrument.parameters, notes: pitches.flatMap((pitch) => [...kinds.values()].map((k) => ({ pitch, ...k }))) }];
  });
}

export function initAccompany(s: Store) {
  store = s;
  onMidiEvent((e) => {
    if (e.type === 'on') {
      held.add(e.pitch);
      if (pitchClasses([...held]).length >= 3) lastChord = [...held];
    } else if (e.type === 'off') {
      held.delete(e.pitch);
    } else {
      return;
    }
    if (!band) return;
    if (e.type === 'off') { band.acc.noteOff(e.pitch); return; }
    const at = beatOf(band.clock, Math.max(e.time, audioContext.currentTime) + MARGIN);
    apply(band.acc.noteOn(e.pitch, at));
  });
  // The band plays while the transport does, and starts over when it jumps
  onTransportChange(() => {
    if (!state.on) return;
    const clock = transportClock();
    if (!clock) { stopBand(); return; }
    if (band && sameClock(band.clock, clock)) return;
    stopBand();
    startBand(clock);
  });
  // It belongs to the coach's Chords mode
  subscribeCoach(() => {
    const coach = getCoachState();
    if (state.on && (!coach.open || coach.mode !== 'chords')) setAccompany(false);
  });
}

// For the browser tests: what the band played, what it's holding now, and
// the renders still to do before its sounds are all ready
export const accompanyDebug = {
  played: () => played.map((p) => ({ ...p })),
  warming: () => prewarmPending(),
  sounding: () => (band ? [...band.notes.values()].filter((n) => n.end > audioContext.currentTime).length : 0),
  running: () => band !== null
};
