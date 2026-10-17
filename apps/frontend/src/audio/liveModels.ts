// Live physical models (#106): a library sound made of physical models,
// played from input (the computer keyboard, MIDI, on-screen keys), plays
// live in an AudioWorklet: for as long as the key is held, ringing out by
// its own physics when let go. Clips, freezing and previews keep playing
// rendered notes, which are cached and the same every time.
//
// What a note needs that can't be measured on the audio thread is measured
// in a worker, once, and cached: the sound's loudness (by rendering it once,
// as `render` normalizes it) and its closed loops' tunings, per note. A key
// pressed before they're ready starts when they are, if still held (#137);
// the selected track's keys are measured ahead (libraryWarmup.ts).

import { playsLive, type LiveTarget, type SoundRecipe } from '@noprod/sound';
import { measureLive } from './library';
import liveModelsUrl from './worklets/live-models.ts?worker&url';
import type { LiveModelsMessage } from './worklets/live-models';

// The contexts the worklet is registered on
const ready = new WeakSet<BaseAudioContext>();

// Registers the worklet on a context (the live one, at startup); until it's
// ready there, and on any other context, notes play rendered buffers
export async function loadLiveModels(ctx: BaseAudioContext) {
  await ctx.audioWorklet.addModule(liveModelsUrl);
  ready.add(ctx);
}

// One worklet node per destination (a track's strip)
const nodes = new WeakMap<AudioNode, AudioWorkletNode>();
const allNodes = new Set<AudioWorkletNode>();

function nodeFor(ctx: BaseAudioContext, destination: AudioNode) {
  let node = nodes.get(destination);
  if (!node) {
    // how far behind it may fall before the device runs out: what's queued for it
    const margin = 1000 * Math.max(ctx instanceof AudioContext ? ctx.outputLatency || ctx.baseLatency : 0, 0.01);
    node = new AudioWorkletNode(ctx, 'noprod-live-models', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { margin } });
    node.connect(destination);
    nodes.set(destination, node);
    allNodes.add(node);
  }
  return node;
}

const send = (node: AudioWorkletNode, m: LiveModelsMessage) => node.port.postMessage(m);

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

// A held note of `sound` (the instrument's: Tune and Gain from `params`), or
// null if it doesn't play live
export function startLiveVoice(
  ctx: BaseAudioContext, destination: AudioNode, sound: SoundRecipe, params: any, note: number, when: number, velocity: number
): { release: (at: number) => void } | null {
  if (!ready.has(ctx) || !playsLive(sound)) return null;
  const node = nodeFor(ctx, destination);
  const v = sixteenth(velocity);
  const transpose = params.Tune ?? 0;
  const id = nextId++;
  let started = false, released = false;
  const on = (m: Measured, at: number) => {
    started = true;
    send(node, {
      type: 'on', id, recipe: sound, note, velocity: v, transpose,
      gain: m.gain * (params.Gain ?? 0.8), tunings: m.tunings, at
    });
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
      if (started) send(node, { type: 'off', id, at });
    }
  };
}

// A control moved (see LIVE_CONTROLS): every live voice at `destination`,
// and those started after it, follow
export function controlLiveVoices(ctx: BaseAudioContext, destination: AudioNode, control: { to: LiveTarget; value: number; smoothing: number }, at: number) {
  if (!ready.has(ctx)) return;
  send(nodeFor(ctx, destination), { type: 'control', ...control, at });
}

// How the worklets are coping: voices sounding, blocks made, those that
// took longer to make than they last (late), dropouts (falling further
// behind than the device had queued: it ran out), the slowest (ms) and the
// share of the time spent making them (load)
export async function liveModelStats() {
  const all = await Promise.all([...allNodes].map((node) => new Promise<any>((resolve) => {
    const listen = (e: MessageEvent) => {
      if (e.data?.type !== 'stats') return;
      node.port.removeEventListener('message', listen);
      resolve(e.data);
    };
    node.port.addEventListener('message', listen);
    node.port.start();
    send(node, { type: 'stats' });
  })));
  return {
    nodes: all.length,
    voices: all.reduce((s, x) => s + x.voices, 0),
    blocks: all.reduce((s, x) => s + x.blocks, 0),
    late: all.reduce((s, x) => s + x.late, 0),
    dropouts: all.reduce((s, x) => s + x.dropouts, 0),
    worst: Math.max(0, ...all.map((x) => x.worst)),
    load: all.reduce((s, x) => s + (x.seconds > 0 ? x.busy / (x.seconds * 1000) : 0), 0)
  };
}
