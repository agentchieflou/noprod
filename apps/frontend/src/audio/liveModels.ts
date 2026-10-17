// Live physical models (#106): a library sound made of physical models,
// played from input (the computer keyboard, MIDI, on-screen keys), plays
// live on the engine worklet (dsp/liveVoices.ts): for as long as the key is
// held, ringing out by its own physics when let go. Clips, freezing and
// previews keep playing rendered notes, which are cached and the same
// every time.
//
// What a note needs that can't be measured on the audio thread is measured
// in a worker, once, and cached: the sound's loudness (by rendering it once,
// as `render` normalizes it) and its closed loops' tunings, per note. A key
// pressed before they're ready starts when they are, if still held (#137);
// the selected track's keys are measured ahead (libraryWarmup.ts).

import { playsLive, type LiveTarget, type SoundRecipe } from '@noprod/sound';
import { measureLive } from './library';
import { liveEngine } from './engineNode';

// Measured, per sound: its gain by sample rate, and tunings by note
interface Measured { gain: number; tunings: number[] }
const measured = new WeakMap<SoundRecipe, Map<string, Measured | Promise<Measured>>>();
type LiveNoteKey = { note: number; velocity: number; transpose: number };
const noteKey = (n: LiveNoteKey, sampleRate: number) => `${n.note}|${n.velocity}|${n.transpose}|${sampleRate}`;

function measure(sound: SoundRecipe, notes: LiveNoteKey[], sampleRate: number, soon: boolean) {
  let byNote = measured.get(sound);
  if (!byNote) measured.set(sound, (byNote = new Map()));
  const todo = notes.filter((n) => !byNote.has(noteKey(n, sampleRate)));
  if (todo.length) {
    const job = measureLive(sound, sampleRate, todo, soon);
    todo.forEach((n, i) => {
      const key = noteKey(n, sampleRate);
      const one = job.then((m) => { const x = { gain: m.gain, tunings: m.tunings[i] }; byNote.set(key, x); return x; });
      one.catch(() => byNote.delete(key)); // try again next time
      byNote.set(key, one);
    });
  }
  return notes.map((n) => byNote.get(noteKey(n, sampleRate))!);
}

// velocities to 1/16, as rendered notes are, so tunings are shared
const sixteenth = (velocity: number) => Math.max(1, Math.round(Math.min(1, Math.max(0, velocity)) * 16)) / 16;

// Measures a sound's keys (at a velocity) ahead of playing them
export function prewarmLive(sound: SoundRecipe, params: any, pitches: number[], velocity: number, sampleRate: number) {
  if (!playsLive(sound)) return;
  const transpose = params.Tune ?? 0;
  measure(sound, pitches.map((note) => ({ note, velocity: sixteenth(velocity), transpose })), sampleRate, false).forEach((m) => {
    if (m instanceof Promise) m.catch(() => {});
  });
}

let nextId = 1;

// A held note of `sound` (the instrument's: Tune and Gain from `params`) on
// a strip of the live engine, or null if it doesn't play live there
export function startLiveVoice(
  ctx: BaseAudioContext, strip: number, sound: SoundRecipe, params: any, note: number, when: number, velocity: number
): { release: (at: number) => void } | null {
  const engine = liveEngine();
  if (!engine || engine.ctx !== ctx || !playsLive(sound)) return null;
  const v = sixteenth(velocity);
  const transpose = params.Tune ?? 0;
  const key = `model:${nextId++}`;
  let started = false, released = false;
  const on = (m: Measured, at: number) => {
    started = true;
    engine.liveOn(key, strip, at, { kind: 'model', recipe: sound, note, velocity: v, transpose, gain: m.gain * (params.Gain ?? 0.8), tunings: m.tunings });
  };
  const [m] = measure(sound, [{ note, velocity: v, transpose }], ctx.sampleRate, true);
  if (m instanceof Promise) {
    m.then((x) => { if (!released) on(x, Math.max(when, ctx.currentTime)); }, () => {});
  } else {
    on(m, when);
  }
  return {
    release(at: number) {
      if (released) return;
      released = true;
      if (started) engine.liveOff(key, at);
    }
  };
}

// A control moved (see LIVE_CONTROLS): every live voice on the strip, and
// those started after it, follow
export function controlLiveVoices(strip: number, control: { to: LiveTarget; value: number; smoothing: number }, at: number) {
  liveEngine()?.control(strip, control, at);
}

// How the engine is coping with the models: voices sounding, blocks made,
// those that took longer to make than they last (late), dropouts (falling
// further behind than the device had queued: it ran out), the slowest
// (ms) and the share of the time spent making them (load)
export async function liveModelStats() {
  const engine = liveEngine();
  const s = engine ? await engine.stats() : null;
  return {
    nodes: engine ? 1 : 0,
    voices: s?.voices ?? 0,
    blocks: s?.blocks ?? 0,
    late: s?.blocksLate ?? 0,
    dropouts: s?.dropouts ?? 0,
    worst: s?.worst ?? 0,
    load: s && s.seconds > 0 ? s.busy / (s.seconds * 1000) : 0
  };
}
