// Live physical models (#106): a library sound made of physical models,
// played from input (the computer keyboard, MIDI, on-screen keys), plays
// live in an AudioWorklet: for as long as the key is held, ringing out by
// its own physics when let go. Clips, freezing and previews keep playing
// rendered notes, which are cached and the same every time.
//
// What a note needs that can't be measured on the audio thread is measured
// here, once, and cached: the sound's loudness (by rendering it once, as
// `render` normalizes it) and its closed loops' tunings, per note.

import { liveTunings, loudnessGain, playsLive, type LiveTarget, type SoundRecipe } from '@noprod/sound';
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

const gains = new WeakMap<SoundRecipe, Map<number, number>>();
const tunings = new WeakMap<SoundRecipe, Map<string, number[]>>();

function gainOf(sound: SoundRecipe, sampleRate: number) {
  let byRate = gains.get(sound);
  if (!byRate) gains.set(sound, (byRate = new Map()));
  let gain = byRate.get(sampleRate);
  if (gain === undefined) byRate.set(sampleRate, (gain = loudnessGain(sound, sampleRate) * Math.pow(10, (sound.gain ?? 0) / 20)));
  return gain;
}

function tuningsOf(sound: SoundRecipe, note: number, velocity: number, transpose: number, sampleRate: number) {
  let byNote = tunings.get(sound);
  if (!byNote) tunings.set(sound, (byNote = new Map()));
  const key = `${note}|${velocity}|${transpose}|${sampleRate}`;
  let t = byNote.get(key);
  if (!t) byNote.set(key, (t = liveTunings(sound, note, velocity, sampleRate, transpose)));
  return t;
}

let nextId = 1;

// A held note of `sound` (the instrument's: Tune and Gain from `params`), or
// null if it doesn't play live
export function startLiveVoice(
  ctx: BaseAudioContext, destination: AudioNode, sound: SoundRecipe, params: any, note: number, when: number, velocity: number
): { release: (at: number) => void } | null {
  if (!ready.has(ctx) || !playsLive(sound)) return null;
  const node = nodeFor(ctx, destination);
  // velocities to 1/16, as rendered notes are, so tunings are shared
  const v = Math.max(1, Math.round(Math.min(1, Math.max(0, velocity)) * 16)) / 16;
  const transpose = params.Tune ?? 0;
  const id = nextId++;
  send(node, {
    type: 'on', id, recipe: sound, note, velocity: v, transpose,
    gain: gainOf(sound, ctx.sampleRate) * (params.Gain ?? 0.8),
    tunings: tuningsOf(sound, note, v, transpose, ctx.sampleRate),
    at: when
  });
  let released = false;
  return {
    release(at: number) {
      if (released) return;
      released = true;
      send(node, { type: 'off', id, at });
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
