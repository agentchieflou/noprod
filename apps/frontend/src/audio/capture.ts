// Capture MIDI: every incoming MIDI event is buffered in the background
// together with the tracks it played on (armed / monitor-In MIDI tracks, or
// the track the computer keyboard plays), so after playing something without
// recording, Capture turns the most recent phrase into a clip on each of them.
//
// - Played while the transport ran: the clip lands where the notes were
//   played, stretched to whole bars.
// - Played while stopped: the clip starts at the bar under the playhead with
//   the first note on beat 1; in an empty project the tempo is first
//   estimated from the playing (as Ableton does).
// - In Session View the clip goes into the track's first empty slot, looped.

import { audioContext } from './engine';
import { onMidiEvent, midiEventTargets, type MidiEvent } from './inputs';
import { isPlaying, getPosition } from './transport';
import { barAt, barSeconds } from './timeline';
import { estimateBpm } from './warp';

interface Buffered extends MidiEvent { pos: number | null; trackIds: string[] }

const MAX_EVENTS = 4000;
const PHRASE_GAP = 4; // seconds of silence that separate phrases

let buffer: Buffered[] = [];
let capturedUpTo = 0; // ctx time; events before it were already captured
const listeners = new Set<() => void>();
export const onCaptureBufferChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function initCapture(store: { getState: () => any }) {
  onMidiEvent((e) => {
    const trackIds = midiEventTargets(store.getState(), e).map((t: any) => t.id);
    buffer.push({ ...e, pos: isPlaying() ? getPosition() : null, trackIds });
    if (buffer.length > MAX_EVENTS) buffer = buffer.slice(-MAX_EVENTS / 2);
    listeners.forEach((fn) => fn());
  });
}

// Is there uncaptured playing on some track that still exists?
export function hasCapturable(state: any): boolean {
  const ids = new Set((state.tracks || []).map((t: any) => t.id));
  return buffer.some((e) => e.type === 'on' && e.time > capturedUpTo && e.trackIds.some((id) => ids.has(id)));
}

// The latest phrase: walk back from the newest note-on until a long gap
function latestPhrase(events: Buffered[]): Buffered[] {
  const ons = events.filter((e) => e.type === 'on');
  if (!ons.length) return [];
  let first = ons.length - 1;
  while (first > 0 && ons[first].time - ons[first - 1].time < PHRASE_GAP) first--;
  const from = ons[first].time;
  return events.filter((e) => e.time >= from - 1e-6);
}

// Pair note-ons with their note-offs (held notes end now)
function toNotes(events: Buffered[], now: number) {
  const open = new Map<string, Buffered>();
  const notes: { on: Buffered; off: number }[] = [];
  events.forEach((e) => {
    const key = `${e.source}:${e.pitch}`;
    if (e.type === 'on') { open.set(key, e); return; }
    const on = open.get(key);
    if (on) { notes.push({ on, off: e.time }); open.delete(key); }
  });
  open.forEach((on) => notes.push({ on, off: now }));
  return notes.sort((a, b) => a.on.time - b.on.time);
}

// Capture into the store. Returns how many clips were created.
export function captureMidi(state: any): number {
  const now = audioContext.currentTime;
  const fresh = buffer.filter((e) => e.time > capturedUpTo);
  const playedOn = new Set(fresh.flatMap((e) => e.trackIds));
  const targets = (state.tracks || []).filter((t: any) => t.type === 'midi' && playedOn.has(t.id));
  let created = 0;

  // Empty project + stopped: take the tempo from the playing first
  const projectEmpty = !(state.regions || []).length
    && !Object.values(state.sessionClips || {}).some((slots: any) => Object.keys(slots || {}).length);
  let bpm = state.bpm;

  targets.forEach((track: any) => {
    const phrase = latestPhrase(fresh.filter((e) => e.trackIds.includes(track.id)));
    const notes = toNotes(phrase, now);
    if (!notes.length) return;

    const playedWhilePlaying = notes[0].on.pos !== null;
    if (!playedWhilePlaying && projectEmpty && created === 0 && notes.length >= 4) {
      const est = estimateBpm(notes.map((n) => n.on.time - notes[0].on.time), state.bpm);
      if (Math.abs(est - state.bpm) > 0.5) { state.setBpm(est); bpm = est; }
    }

    // Played while running: notes keep their timeline positions and the clip
    // starts on the bar of the first note. Played while stopped: the clip
    // starts on the bar under the playhead with the first note on beat 1.
    const t0 = notes[0].on.time;
    const anchor = playedWhilePlaying ? notes[0].on.pos! : getPosition();
    const bar = barAt(bpm, anchor, state.timeSignatures);
    const start = bar.time;
    const rel = (n: { on: Buffered }) => (playedWhilePlaying ? n.on.pos! - start : n.on.time - t0);
    const barLen = barSeconds(bpm, bar);
    const lastEnd = Math.max(...notes.map((n) => rel(n) + (n.off - n.on.time)));
    const length = Math.max(1, Math.ceil(lastEnd / barLen - 1e-6)) * barLen;
    const clipNotes = notes.map((n, i) => ({
      id: `cap-${Date.now()}-${i}`,
      pitch: n.on.pitch,
      velocity: n.on.velocity,
      start: Math.max(0, rel(n)),
      duration: Math.max(0.02, n.off - n.on.time)
    }));

    if (state.viewMode === 'session') {
      const slots = state.sessionClips?.[track.id] || {};
      const slot = (state.scenes || []).findIndex((_: any, i: number) => !slots[i]);
      if (slot < 0) return;
      state.setSessionClip(track.id, slot, { type: 'midi', file: 'Captured', audioBuffer: null, duration: length, loopEnd: length, notes: clipNotes });
    } else {
      state.addMidiRegion(track.id, start, length, clipNotes);
    }
    created++;
  });

  if (created) {
    capturedUpTo = now;
    listeners.forEach((fn) => fn());
  }
  return created;
}
