// Library instruments (#63): sounds from @noprod/sound played through every
// note path (clips, session, live input, audition, freeze).
//
// A library instrument keeps its recipes in its parameters
// (`Kit: 'library'`, `Library: { sound }` or `{ kit, sounds }`), so a project
// carries the sounds it uses. Notes play rendered buffers, cached by what
// changes the samples. A note's render can take tens of milliseconds, so
// none happens on the main thread (#137): workers render them, a note
// needed now ahead of the rest, and `prewarmLibrary` renders what the
// project's clips need ahead of playback.

import { findSound, type DrumKit, type SoundRecipe } from '@noprod/sound';
import { v4 as uuidv4 } from 'uuid';
import { audioContext } from './engine';
import { WorkerPool } from './workerPool';
import { LruBytes, budgets, bufferBytes } from './memory';
import type { LibraryJob } from './libraryJobs';

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

// What a note renders: the recipe and everything that changes its samples.
// Velocity is rounded to 1/16 and gates to 10 ms so repeats share a render.
interface Render { recipe: SoundRecipe; note: number; velocity: number; gate?: number; transpose: number }

const bufferKey = (r: Render, sampleRate: number) =>
  `${sampleRate}|${r.note}|${r.velocity}|${r.gate ?? '-'}|${r.transpose.toFixed(2)}`;

// Rendered notes, by recipe and key, within the memory budget (memory.ts)
interface Entry { render: Render; sampleRate: number; key: string; buffer: AudioBuffer }
const buffers = new WeakMap<SoundRecipe, Map<string, Entry>>();
const cache = new LruBytes<Entry, Entry>(budgets().renders, (e) => bufferBytes(e.buffer),
  (e) => buffers.get(e.render.recipe)?.delete(e.key));

function cached(r: Render, sampleRate: number): AudioBuffer | undefined {
  const entry = buffers.get(r.recipe)?.get(bufferKey(r, sampleRate));
  if (entry) cache.get(entry); // recently used
  return entry?.buffer;
}

// Cache a note the workers rendered, evicting the least recently used
function store(r: Render, sampleRate: number, left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): AudioBuffer {
  let map = buffers.get(r.recipe);
  if (!map) buffers.set(r.recipe, (map = new Map()));
  const key = bufferKey(r, sampleRate);
  const existing = map.get(key);
  if (existing) return existing.buffer;
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  const entry = { render: r, sampleRate, key, buffer };
  map.set(key, entry);
  cache.set(entry, entry);
  return buffer;
}

// The closest render of the same sound to stand in for a note that isn't
// ready (a live key's fast path): played faster or slower to reach its
// pitch, as a sampler would, within an octave
function nearest(r: Render, sampleRate: number): { buffer: AudioBuffer; rate: number; gain: number } | null {
  const pitch = r.note + r.transpose;
  let best: Entry | null = null, bestCost = Infinity;
  for (const e of buffers.get(r.recipe)?.values() ?? []) {
    if (e.sampleRate !== sampleRate || e.render.gate !== r.gate) continue;
    const semitones = Math.abs(e.render.note + e.render.transpose - pitch);
    const cost = semitones + Math.abs(e.render.velocity - r.velocity) * 8;
    if (semitones <= 12 && cost < bestCost) { best = e; bestCost = cost; }
  }
  if (!best) return null;
  cache.get(best);
  return {
    buffer: best.buffer,
    rate: Math.pow(2, (pitch - best.render.note - best.render.transpose) / 12),
    gain: r.velocity / best.render.velocity
  };
}

// ---------------------------------------------------------------- workers

// Render priorities, lowest first: a key being played, then scheduled notes
// by when they're due (seconds on their context's clock), then offline
// renders (freezing), then prewarm
const LIVE = -1;
const OFFLINE = 1e9;
const PREWARM = 2e9;

// Where workers can't start, the main thread does the same jobs, one per
// task, loading the renderer only then
class MainThreadWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(message: { id: number } & LibraryJob) {
    setTimeout(async () => {
      let data: Record<string, unknown>;
      try {
        data = { ...(await import('./libraryJobs')).runJob(message).data, id: message.id };
      } catch (error) {
        data = { id: message.id, error: error instanceof Error ? error.message : String(error) };
      }
      this.onmessage?.({ data } as MessageEvent);
    });
  }
  terminate() {}
}

const makeWorker = () => new Worker(new URL('./libraryWorker.ts', import.meta.url), { type: 'module' });

// A pool, or one on the main thread if workers can't run
function poolOf(size: number) {
  let pool: WorkerPool | null = null;
  return () => {
    if (pool && pool.available) return pool;
    if (!pool) pool = new WorkerPool(makeWorker, size);
    if (!pool.available) pool = new WorkerPool(() => new MainThreadWorker() as unknown as Worker, 1);
    return pool;
  };
}

// Notes (playback, prewarm, live), a few workers that start on first use...
const notePool = poolOf(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)));
// ...one of the Sound Designer's own, so it never waits behind them...
export const designPool = poolOf(1);
// ...and one for stretching warped clips (warp.ts), a whole clip at a time
export const stretchPool = poolOf(1);

// How note rendering is going, for the tests and the budget: notes that
// weren't ready when asked for, those played late (within LATE_BUDGET) or
// skipped (later than that; when they were due), failed renders, live keys
// that took the fast path, how long recent renders took to arrive (ms), and
// how many are on their way
const stats = { missed: 0, late: 0, skipped: 0, failed: 0, fastPath: 0, skippedAt: [] as number[], waits: [] as number[] };
const keep = (list: number[], x: number) => { list.push(x); if (list.length > 500) list.splice(0, list.length - 250); };

export const libraryStats = () => ({
  ...stats, skippedAt: [...stats.skippedAt], waits: [...stats.waits],
  rendering: inFlight,
  cache: { bytes: cache.bytes, budget: cache.budget, notes: cache.size },
  workers: notePool().workers, replaced: notePool().replaced
});

// Renders a note (once, however many ask), sooner if a caller needs it sooner
const rendering = new WeakMap<SoundRecipe, Map<string, Promise<AudioBuffer>>>();
const recipeTags = new WeakMap<SoundRecipe, number>();
let nextTag = 0;
let inFlight = 0;

function renderNote(r: Render, sampleRate: number, priority: number): Promise<AudioBuffer> {
  const hit = cached(r, sampleRate);
  if (hit) return Promise.resolve(hit);
  const key = bufferKey(r, sampleRate);
  let byKey = rendering.get(r.recipe);
  if (!byKey) rendering.set(r.recipe, (byKey = new Map()));
  let tag = recipeTags.get(r.recipe);
  if (tag === undefined) recipeTags.set(r.recipe, (tag = nextTag++));
  const pool = notePool();
  const existing = byKey.get(key);
  if (existing) {
    pool.raise(`${tag}|${key}`, priority);
    return existing;
  }
  const promise = pool.run({ recipe: r.recipe, options: { note: r.note, velocity: r.velocity, gate: r.gate, transpose: r.transpose, sampleRate } },
    { priority, tag: `${tag}|${key}` })
    .then((d) => store(r, sampleRate, d.left, d.right));
  inFlight++;
  const done = () => { byKey.delete(key); inFlight--; };
  promise.then(done, () => { done(); stats.failed++; });
  byKey.set(key, promise);
  return promise;
}

// Offline contexts (freezing) wait for their notes: see whenRendered
const offlineRenders = new WeakMap<BaseAudioContext, Set<Promise<unknown>>>();
const isRealtime = (ctx: BaseAudioContext) => typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;

function trackOffline(ctx: BaseAudioContext, job: Promise<unknown>) {
  let set = offlineRenders.get(ctx);
  if (!set) offlineRenders.set(ctx, (set = new Set()));
  set.add(job);
  job.finally(() => set.delete(job));
}

// Resolves once every note scheduled on an offline context is in place:
// call it before startRendering()
export async function whenRendered(ctx: BaseAudioContext) {
  const set = offlineRenders.get(ctx);
  while (set?.size) await Promise.allSettled([...set]);
}

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

function play(ctx: BaseAudioContext, destination: AudioNode, buffer: AudioBuffer, when: number, level: number, rate = 1): Voice {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(gain);
  gain.connect(destination);
  src.start(when);
  return { src, gain, start: when, end: when + buffer.duration / rate };
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

type Stoppable = { stop: (when?: number) => void };
const nothing: Stoppable = { stop: () => {} };

// How late a scheduled note may start when its render arrives after it was
// due: later than this it's skipped (and counted), as it would be heard off
// the beat. Measured (perf suite): a cold note takes a worker about 3-40 ms
// to render; the transport schedules 250 ms ahead, so a note is only late
// when a burst of new notes (the first bar from a cold cache) queues up.
export const LATE_BUDGET = 0.03;

// One scheduled note (clips, audition, freeze): see synth.ts triggerNote.
// A note that isn't rendered yet renders in a worker ahead of everything
// due later, and starts when it arrives if that's still useful.
export function triggerLibrary(
  ctx: BaseAudioContext, destination: AudioNode, params: any, note: number, when: number, duration: number, velocity: number
): Stoppable {
  const r = resolve(params, note, velocity, duration);
  if (!r) return nothing;
  const kit = libraryOf(params)?.kit;
  const start = (buffer: AudioBuffer, at: number) => {
    const voice = play(ctx, destination, buffer, at, r.level);
    if (kit && r.pad !== undefined) choke(kit, r.pad, destination, voice);
    return voice;
  };
  const hit = cached(r, ctx.sampleRate);
  if (hit) return start(hit, when).src;

  stats.missed++;
  const realtime = isRealtime(ctx);
  const asked = performance.now();
  let voice: Voice | null = null;
  let stopAt: number | null = null;
  const job = renderNote(r, ctx.sampleRate, realtime ? when : OFFLINE).then((buffer) => {
    keep(stats.waits, performance.now() - asked);
    const at = realtime ? Math.max(when, ctx.currentTime) : when;
    if (stopAt !== null && stopAt <= at) return; // stopped (or taken back) before it could start
    if (at - when > LATE_BUDGET) { stats.skipped++; keep(stats.skippedAt, when); return; }
    if (at > when) stats.late++;
    voice = start(buffer, at);
    if (stopAt !== null) voice.src.stop(stopAt);
  }, () => { /* counted as failed; nothing plays */ });
  if (!realtime) trackOffline(ctx, job);
  return {
    stop(at?: number) {
      if (voice) voice.src.stop(at);
      else stopAt = at ?? (realtime ? ctx.currentTime : 0);
    }
  };
}

// A held note from live input: plays the full-velocity render, scaled, and
// fades with the sound's release when let go. A key whose note isn't
// rendered yet plays the nearest one that is, repitched, while its own
// renders ahead of everything else; with none near, it starts when its
// render arrives, if still held.
export function startLibraryVoice(
  ctx: BaseAudioContext, destination: AudioNode, params: any, note: number, when: number, velocity: number
): { release: (at: number) => void } {
  const sound = libraryOf(params)?.sound;
  const pitched = !!sound?.pitched;
  const v = Math.min(1, Math.max(0, velocity));
  const r = pitched ? resolve(params, note, 1, sound!.length) : resolve(params, note, velocity);
  if (!r) return { release: () => {} };
  const level = pitched ? r.level * v * v : r.level;
  const kit = libraryOf(params)?.kit;
  const realtime = isRealtime(ctx);
  const releaseTime = pitched ? Math.max(0.05, ...sound!.layers.map((l) => l.env?.release ?? 0.05)) : 0;

  let voice: Voice | null = null;
  let releasedAt: number | null = null;
  const begin = (buffer: AudioBuffer, at: number, rate = 1, gain = 1) => {
    voice = play(ctx, destination, buffer, at, level * gain, rate);
    if (kit && r.pad !== undefined) choke(kit, r.pad, destination, voice);
    if (releasedAt !== null) fade(releasedAt);
  };
  const fade = (at: number) => {
    if (!voice || !pitched) return; // one-shots ring out
    const t = Math.max(at, realtime ? ctx.currentTime : 0);
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setTargetAtTime(0, t, releaseTime / 6.9);
    try { voice.src.stop(t + releaseTime); } catch { /* already ended */ }
  };

  const hit = cached(r, ctx.sampleRate);
  if (hit) {
    begin(hit, when);
  } else {
    stats.missed++;
    const near = realtime ? nearest(r, ctx.sampleRate) : null;
    if (near) {
      stats.fastPath++;
      begin(near.buffer, when, near.rate, near.gain);
      renderNote(r, ctx.sampleRate, LIVE).catch(() => {}); // the key's own render, for next time
    } else {
      const asked = performance.now();
      const job = renderNote(r, ctx.sampleRate, realtime ? LIVE : OFFLINE).then((buffer) => {
        keep(stats.waits, performance.now() - asked);
        if (realtime && releasedAt !== null && pitched) return; // let go before it was ready
        begin(buffer, realtime ? Math.max(when, ctx.currentTime) : when);
      }, () => {});
      if (!realtime) trackOffline(ctx, job);
    }
  }
  return {
    release(at: number) {
      if (releasedAt !== null) return;
      releasedAt = at;
      fade(at);
    }
  };
}

// --------------------------------------------------------------- preview

// Plays straight to the speakers, like a sample preview in the Browser
export const previewGain = audioContext.createGain();
previewGain.gain.value = 0.8;
previewGain.connect(audioContext.destination);
let previewing: Stoppable[] = [];

export function stopSoundPreview() {
  previewId++;
  previewing.forEach((s) => { try { s.stop(); } catch { /* not started */ } });
  previewing = [];
}

// Notes rendered ahead of everything else, for playing them now
function renderNow(params: any, notes: [number, number, number][]) {
  return Promise.allSettled(notes.map(([note, velocity, duration]) => {
    const r = resolve(params, note, velocity, duration);
    return r ? renderNote(r, audioContext.sampleRate, LIVE) : null;
  }));
}

// A preview starts when its notes are ready (unless another took its place)
let previewId = 0;

export async function previewSound(recipe: SoundRecipe, note = recipe.root ?? 60) {
  stopSoundPreview();
  const id = ++previewId;
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { sound: recipe } };
  await renderNow(params, [[note, 0.9, 0.8]]);
  if (id !== previewId) return;
  previewing.push(triggerLibrary(audioContext, previewGain, params, note, audioContext.currentTime + 0.01, 0.8, 0.9));
}

// A bar of kick, snare and hats
const KIT_PREVIEW = [[36, 42], [42], [38, 42], [42], [36, 42], [36, 42], [38, 42], [46]];
const velocityOf = (note: number) => (note === 42 ? 0.6 : 0.9);

export async function previewKit(kit: DrumKit, sounds: Record<string, SoundRecipe>) {
  stopSoundPreview();
  const id = ++previewId;
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { kit, sounds } };
  await renderNow(params, [...new Set(KIT_PREVIEW.flat())].map((note) => [note, velocityOf(note), 0.1]));
  if (id !== previewId) return;
  const start = audioContext.currentTime + 0.02;
  KIT_PREVIEW.forEach((notes, step) => notes.forEach((note) => {
    previewing.push(triggerLibrary(audioContext, previewGain, params, note, start + step * 0.2, 0.1, velocityOf(note)));
  }));
}

// A sound as an audio clip's buffer (dragged onto an audio track or slot)
export function soundAsBuffer(recipe: SoundRecipe): Promise<AudioBuffer> {
  const r = resolve({ Kit: 'library', Library: { sound: recipe } }, recipe.root ?? 60, 1, recipe.pitched ? 1 : undefined)!;
  return renderNote(r, audioContext.sampleRate, LIVE);
}

// What a live physical model needs (see liveModels.ts): the sound's level
// and each note's loop tunings, measured in a worker
export function measureLive(recipe: SoundRecipe, sampleRate: number, notes: { note: number; velocity: number; transpose: number }[], soon = true) {
  return notePool().run<{ gain: number; tunings: number[][] }>({ kind: 'live', recipe, sampleRate, notes }, { priority: soon ? LIVE : PREWARM });
}

// ---------------------------------------------------------------- prewarm

type Note = { pitch: number; velocity: number; duration: number };
type Job = { params: any; note: Note };
let queue: Job[] = [];
let warming = 0; // prewarm renders in the workers

// Notes still to render in the background
export const prewarmPending = () => queue.length + warming;

// Render every listed note that isn't cached yet, in the background
// (replacing whatever an earlier call still had queued)
export function prewarmLibrary(tracks: { params: any; notes: Note[] }[]) {
  queue = tracks.flatMap((t) => t.notes.map((note) => ({ params: t.params, note })));
  step();
}

// Feeds the workers one note each, keeping one free for notes needed now,
// and only while nothing more urgent waits
let stepping = false;
function step() {
  if (stepping || !queue.length) return; // workers start when there's work
  stepping = true;
  const sampleRate = audioContext.sampleRate;
  const pool = notePool();
  pool.onIdle = step;
  const room = Math.max(1, pool.workers - 1);
  while (queue.length && pool.queued === 0 && pool.busy < room) {
    const { params, note } = queue.shift()!;
    const r = resolve(params, note.pitch, note.velocity, note.duration);
    if (!r || cached(r, sampleRate) || rendering.get(r.recipe)?.has(bufferKey(r, sampleRate))) continue;
    warming++;
    const done = () => { warming--; };
    renderNote(r, sampleRate, PREWARM).then(done, done);
  }
  stepping = false;
}
