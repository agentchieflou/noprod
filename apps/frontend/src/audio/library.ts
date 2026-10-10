// Library instruments (#63): sounds from @noprod/sound played through every
// note path (clips, session, live input, audition, freeze).
//
// A library instrument keeps its recipes in its parameters
// (`Kit: 'library'`, `Library: { sound }` or `{ kit, sounds }`), so a project
// carries the sounds it uses. Notes play rendered buffers, cached by what
// changes the samples; `prewarmLibrary` renders what the project's clips
// need ahead of playback, since a note's render can take tens of milliseconds.

import { render, findSound, type DrumKit, type SoundRecipe } from '@noprod/sound';
import { v4 as uuidv4 } from 'uuid';
import { audioContext } from './engine';

export interface LibraryInstrument {
  sound?: SoundRecipe;                 // one sound across the keyboard
  kit?: DrumKit;                       // or a kit: notes to sounds
  sounds?: Record<string, SoundRecipe>; // the kit's sounds, by id
}

export const libraryOf = (params: any): LibraryInstrument | null =>
  params?.Kit === 'library' && params.Library ? params.Library : null;

export const isLibraryKit = (params: any) => !!libraryOf(params)?.kit;

// A MIDI track instrument playing one library sound
export const createLibraryInstrument = (sound: SoundRecipe) => ({
  id: uuidv4(),
  name: sound.name,
  type: 'instrument',
  parameters: { Kit: 'library', Tune: 0, Gain: 0.8, Library: { sound } }
});

// ...or a library kit, with every sound its pads use
export const createLibraryKit = (kit: DrumKit) => ({
  id: uuidv4(),
  name: kit.name,
  type: 'instrument',
  parameters: {
    Kit: 'library', Tune: 0, Gain: 0.8,
    Library: { kit, sounds: kitSounds(kit) }
  }
});

export const kitSounds = (kit: DrumKit): Record<string, SoundRecipe> => Object.fromEntries(
  Object.values(kit.pads).map((pad) => [pad.sound, findSound(pad.sound)]).filter(([, s]) => s)
);

const dbToGain = (db: number) => Math.pow(10, db / 20);

// ---------------------------------------------------------------- buffers

const MAX_BYTES = 256 * 1024 * 1024;
interface Entry { map: Map<string, AudioBuffer>; key: string; bytes: number }
const buffers = new WeakMap<SoundRecipe, Map<string, AudioBuffer>>();
const recent = new Set<Entry>(); // least recently used first
const entries = new WeakMap<AudioBuffer, Entry>();
let totalBytes = 0;

// What a note renders: the recipe and everything that changes its samples.
// Velocity is rounded to 1/16 and gates to 10 ms so repeats share a render.
interface Render { recipe: SoundRecipe; note: number; velocity: number; gate?: number; transpose: number }

const bufferKey = (r: Render, sampleRate: number) =>
  `${sampleRate}|${r.note}|${r.velocity}|${r.gate ?? '-'}|${r.transpose.toFixed(2)}`;

function bufferFor(r: Render, sampleRate: number): AudioBuffer {
  let map = buffers.get(r.recipe);
  if (!map) buffers.set(r.recipe, (map = new Map()));
  const key = bufferKey(r, sampleRate);
  const cached = map.get(key);
  if (cached) {
    const entry = entries.get(cached)!;
    recent.delete(entry);
    recent.add(entry);
    return cached;
  }

  const { left, right } = render(r.recipe, { note: r.note, velocity: r.velocity, gate: r.gate, transpose: r.transpose, sampleRate });
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);

  const entry = { map, key, bytes: left.length * 8 };
  map.set(key, buffer);
  entries.set(buffer, entry);
  recent.add(entry);
  totalBytes += entry.bytes;
  for (const old of recent) {
    if (totalBytes <= MAX_BYTES) break;
    old.map.delete(old.key);
    recent.delete(old);
    totalBytes -= old.bytes;
  }
  return buffer;
}

const isCached = (r: Render, sampleRate: number) => !!buffers.get(r.recipe)?.has(bufferKey(r, sampleRate));

// The render a note needs, and its level, or null if nothing plays it
function resolve(params: any, note: number, velocity: number, duration?: number): (Render & { level: number; pad?: number }) | null {
  const lib = libraryOf(params);
  if (!lib) return null;
  const v = Math.max(1, Math.round(Math.min(1, Math.max(0, velocity)) * 16)) / 16;
  const tune = params.Tune ?? 0;
  const level = params.Gain ?? 0.8;

  if (lib.kit) {
    const pad = lib.kit.pads[note];
    const recipe = pad && lib.sounds?.[pad.sound];
    if (!recipe) return null;
    return { recipe, note: recipe.root ?? 60, velocity: v, transpose: (pad.transpose ?? 0) + tune, level: level * dbToGain(pad.gain ?? 0), pad: note };
  }
  const recipe = lib.sound;
  if (!recipe) return null;
  // A pitched sound holds for the note; a one-shot plays chromatically, as a sampler would
  return recipe.pitched
    ? { recipe, note, velocity: v, gate: Math.max(0.01, Math.round((duration ?? recipe.length) * 100) / 100), transpose: tune, level }
    : { recipe, note: recipe.root ?? 60, velocity: v, transpose: note - 60 + tune, level };
}

// --------------------------------------------------------------- playing

interface Voice { src: AudioBufferSourceNode; gain: GainNode; start: number; end: number }

function play(ctx: BaseAudioContext, destination: AudioNode, buffer: AudioBuffer, when: number, level: number): Voice {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(gain);
  gain.connect(destination);
  src.start(when);
  return { src, gain, start: when, end: when + buffer.duration };
}

// Kit choke groups (a closed hat cuts an open one off), per destination
const sounding = new WeakMap<AudioNode, Map<number, Voice[]>>();

function choke(kit: DrumKit, note: number, destination: AudioNode, voice: Voice) {
  const group = kit.chokes?.findIndex((g) => g.includes(note)) ?? -1;
  if (group < 0) return;
  let groups = sounding.get(destination);
  if (!groups) sounding.set(destination, (groups = new Map()));
  const keep: Voice[] = [];
  for (const v of groups.get(group) ?? []) {
    if (v.end <= voice.start) continue;
    if (v.start < voice.start) {
      v.gain.gain.setTargetAtTime(0, voice.start, 0.008);
      try { v.src.stop(voice.start + 0.06); } catch { /* already stopped */ }
    } else {
      keep.push(v); // scheduled after this hit
    }
  }
  groups.set(group, [...keep, voice]);
}

const silence = (ctx: BaseAudioContext, when: number) => {
  const src = ctx.createBufferSource();
  src.start(when);
  src.stop(when);
  return src;
};

// One scheduled note (clips, audition, freeze): see synth.ts triggerNote
export function triggerLibrary(
  ctx: BaseAudioContext, destination: AudioNode, params: any, note: number, when: number, duration: number, velocity: number
): AudioScheduledSourceNode {
  const r = resolve(params, note, velocity, duration);
  if (!r) return silence(ctx, when);
  const voice = play(ctx, destination, bufferFor(r, ctx.sampleRate), when, r.level);
  const kit = libraryOf(params)?.kit;
  if (kit && r.pad !== undefined) choke(kit, r.pad, destination, voice);
  return voice.src;
}

// A held note from live input: plays the full-velocity render, scaled, and
// fades with the sound's release when let go
export function startLibraryVoice(
  ctx: BaseAudioContext, destination: AudioNode, params: any, note: number, when: number, velocity: number
): { release: (at: number) => void } {
  const sound = libraryOf(params)?.sound;
  if (!sound?.pitched) {
    triggerLibrary(ctx, destination, params, note, when, 0, velocity);
    return { release: () => {} };
  }
  const r = resolve(params, note, 1, sound.length)!;
  const v = Math.min(1, Math.max(0, velocity));
  const voice = play(ctx, destination, bufferFor(r, ctx.sampleRate), when, r.level * v * v);
  const release = Math.max(0.05, ...sound.layers.map((l) => l.env?.release ?? 0.05));
  let released = false;
  return {
    release(at: number) {
      if (released) return;
      released = true;
      const t = Math.max(at, ctx.currentTime);
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setTargetAtTime(0, t, release / 6.9);
      try { voice.src.stop(t + release); } catch { /* already ended */ }
    }
  };
}

// --------------------------------------------------------------- preview

// Plays straight to the speakers, like a sample preview in the Browser
const previewGain = audioContext.createGain();
previewGain.gain.value = 0.8;
previewGain.connect(audioContext.destination);
let previewing: AudioBufferSourceNode[] = [];

export function stopSoundPreview() {
  previewing.forEach((s) => { try { s.stop(); } catch { /* not started */ } });
  previewing = [];
}

export function previewSound(recipe: SoundRecipe, note = recipe.root ?? 60) {
  stopSoundPreview();
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { sound: recipe } };
  previewing.push(triggerLibrary(audioContext, previewGain, params, note, audioContext.currentTime + 0.01, 0.8, 0.9) as AudioBufferSourceNode);
}

// A bar of kick, snare and hats
const KIT_PREVIEW = [[36, 42], [42], [38, 42], [42], [36, 42], [36, 42], [38, 42], [46]];

export function previewKit(kit: DrumKit, sounds: Record<string, SoundRecipe>) {
  stopSoundPreview();
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { kit, sounds } };
  const start = audioContext.currentTime + 0.02;
  KIT_PREVIEW.forEach((notes, step) => notes.forEach((note) => {
    previewing.push(triggerLibrary(audioContext, previewGain, params, note, start + step * 0.2, 0.1, note === 42 ? 0.6 : 0.9) as AudioBufferSourceNode);
  }));
}

// A sound as an audio clip's buffer (dragged onto an audio track or slot)
export function soundAsBuffer(recipe: SoundRecipe): AudioBuffer {
  const r = resolve({ Kit: 'library', Library: { sound: recipe } }, recipe.root ?? 60, 1, recipe.pitched ? 1 : undefined)!;
  return bufferFor(r, audioContext.sampleRate);
}

// ---------------------------------------------------------------- prewarm

type Note = { pitch: number; velocity: number; duration: number };
let queue: { params: any; note: Note }[] = [];
let working = false;

// Render, a little at a time, every listed note that isn't cached yet
// (replacing what an earlier call still had queued)
export function prewarmLibrary(tracks: { params: any; notes: Note[] }[]) {
  queue = tracks.flatMap((t) => t.notes.map((note) => ({ params: t.params, note })));
  if (!working) step();
}

function step() {
  const sampleRate = audioContext.sampleRate;
  while (queue.length) {
    const { params, note } = queue.shift()!;
    const r = resolve(params, note.pitch, note.velocity, note.duration);
    if (!r || isCached(r, sampleRate)) continue;
    working = true;
    bufferFor(r, sampleRate);
    setTimeout(step, 0); // one render per task keeps the page responsive
    return;
  }
  working = false;
}
