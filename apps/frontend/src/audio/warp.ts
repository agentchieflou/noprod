// Warping: transient detection, tempo estimation, and each warped clip
// stretched to the project tempo by our phase vocoder (@noprod/sound's
// `stretch`) in a worker. Until a clip's render is ready, clipPlayback.ts
// plays it with overlap-add grains (sized per warp mode): live at once, but
// with audible artifacts on extreme ratios. Texture keeps its grains (their
// jitter is the effect) and Re-Pitch resamples.

import type { StretchMode, StretchOptions } from '@noprod/sound';

export function detectTransients(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = Math.floor(sr * 0.02); // 20ms energy windows
  const energies: number[] = [];
  for (let i = 0; i + win < data.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += data[j] * data[j];
    energies.push(e / win);
  }
  const transients: number[] = [];
  let last = -1;
  for (let i = 1; i < energies.length; i++) {
    const rise = energies[i] / (energies[i - 1] + 1e-6);
    if (rise > 2.5 && energies[i] > 0.0005) {
      const t = (i * win) / sr;
      if (t - last > 0.09) { // 90ms refractory window
        transients.push(t);
        last = t;
      }
    }
  }
  return transients;
}

// Median transient interval folded into 70-180 BPM.
export function estimateBpm(transients: number[], fallback = 120): number {
  if (transients.length < 4) return fallback;
  const intervals: number[] = [];
  for (let i = 1; i < transients.length; i++) intervals.push(transients[i] - transients[i - 1]);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (median <= 0.01) return fallback;
  let bpm = 60 / median;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// ------------------------------------------------------------ rendered stretch

// The warp modes the stretcher renders, as its modes
const RENDERED: Record<string, StretchMode> = { complex: 'complex', beats: 'beats', tones: 'tones' };

// Each source buffer's renders by settings (null while rendering, or if it
// failed); the latest few are kept
const renders = new WeakMap<AudioBuffer, Map<string, AudioBuffer | null>>();
const KEEP = 3;
const readyListeners = new Set<() => void>();

// Called whenever a render becomes ready
export const onStretchReady = (fn: () => void) => {
  readyListeners.add(fn);
  return () => { readyListeners.delete(fn); };
};

function settings(clip: any, bpm: number): StretchOptions & { key: string } | null {
  const mode = RENDERED[clip.warpMode];
  if (!clip.warpEnabled || !clip.originalBpm || !clip.audioBuffer || !mode) return null;
  const ratio = clip.originalBpm / bpm;
  const semitones = (clip.transpose || 0) + (clip.detune || 0) / 100;
  const sampleRate = (clip.audioBuffer as AudioBuffer).sampleRate;
  return { sampleRate, ratio, semitones, mode, key: `${mode} ${ratio.toFixed(6)} ${semitones}` };
}

// A warped clip's whole buffer stretched to `bpm` (its transposition kept),
// or null until that's rendered (and the render is asked for)
export function stretchedBuffer(clip: any, bpm: number): AudioBuffer | null {
  const s = settings(clip, bpm);
  if (!s) return null;
  const source: AudioBuffer = clip.audioBuffer;
  let byKey = renders.get(source);
  if (!byKey) renders.set(source, (byKey = new Map()));
  if (byKey.has(s.key)) return byKey.get(s.key)!;
  if (byKey.size >= KEEP) byKey.delete(byKey.keys().next().value!);
  byKey.set(s.key, null);
  const { key, ...options } = s;
  const held = byKey;
  ask(source, options).then((buffer) => {
    if (!held.has(key)) return; // dropped meanwhile
    held.set(key, buffer);
    readyListeners.forEach((fn) => fn());
  }, () => { /* stays on grains */ });
  return null;
}

// Renders every warped clip at the project tempo, as soon as either changes
export function initWarpRenders(store: { getState: () => any; subscribe: (fn: (s: any, prev: any) => void) => unknown }) {
  const all = (st: any) => {
    const bpm = st.bpm || 120;
    (st.regions || []).forEach((r: any) => stretchedBuffer(r, bpm));
    Object.values(st.sessionClips || {}).forEach((slots: any) => Object.values(slots || {}).forEach((c: any) => c && stretchedBuffer(c, bpm)));
  };
  store.subscribe((st, prev) => {
    if (st.regions !== prev.regions || st.sessionClips !== prev.sessionClips || st.bpm !== prev.bpm) all(st);
  });
  all(store.getState());
}

// One worker, one clip at a time; none if workers can't start (then grains)
let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (b: AudioBuffer) => void; reject: (e: unknown) => void; sampleRate: number }>();

function ask(source: AudioBuffer, options: StretchOptions): Promise<AudioBuffer> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./stretchWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; channels?: Float32Array<ArrayBuffer>[]; error?: string }>) => {
        const job = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (!job) return;
        const channels = e.data.channels;
        if (!channels) { job.reject(new Error(e.data.error)); return; }
        const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: Math.max(1, channels[0].length), sampleRate: job.sampleRate });
        channels.forEach((c, i) => buffer.copyToChannel(c, i));
        job.resolve(buffer);
      };
      // A crashed worker fails what it held; the next ask starts another
      worker.onerror = () => {
        waiting.forEach((job) => job.reject(new Error('stretch worker failed')));
        waiting.clear();
        worker = undefined;
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) return Promise.reject(new Error('no workers'));
  const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice());
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, sampleRate: source.sampleRate });
    worker!.postMessage({ id, channels, options }, channels.map((c) => c.buffer));
  });
}
