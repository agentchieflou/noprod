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

// Finished renders, least recently used first, within a memory budget: about
// 32 MB per GB of device memory
const ready = new Map<string, { buffer: AudioBuffer; bytes: number }>();
let budget = 32 * 2 ** 20 * ((navigator as any).deviceMemory || 4);
let held = 0;

// Each source buffer's work: at most one render in flight, and the latest
// settings asked for, started once the tempo has settled (a tempo that
// moves continuously, as the Tempo Follower's or a drag, asks for a render
// at every step; the ones it overtakes are dropped)
type Job = {
  id: number; busy: string | null; want: (StretchOptions & { key: string }) | null;
  timer: ReturnType<typeof setTimeout> | null; failed: Set<string>;
};
const jobs = new WeakMap<AudioBuffer, Job>();
let sourceIds = 0;
const SETTLE_MS = 250;
let started = 0;
const readyListeners = new Set<() => void>();

// Called whenever a render becomes ready
export const onStretchReady = (fn: () => void) => {
  readyListeners.add(fn);
  return () => { readyListeners.delete(fn); };
};

// For the tests: renders started, bytes held, and the budget (settable)
export const stretchStats = () => ({ started, bytes: held, budget, renders: ready.size });
export function setStretchBudget(bytes: number) {
  budget = bytes;
  evict();
}

function evict() {
  for (const [key, r] of ready) {
    if (held <= budget) break;
    ready.delete(key);
    held -= r.bytes;
  }
}

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
  let job = jobs.get(source);
  if (!job) jobs.set(source, (job = { id: sourceIds++, busy: null, want: null, timer: null, failed: new Set() }));
  const id = `${job.id} ${s.key}`;
  const hit = ready.get(id);
  if (hit) {
    ready.delete(id); // most recently used
    ready.set(id, hit);
    return hit.buffer;
  }
  if (job.busy !== s.key && job.want?.key !== s.key && !job.failed.has(s.key)) {
    job.want = s;
    if (job.timer) clearTimeout(job.timer);
    const j = job;
    job.timer = setTimeout(() => { j.timer = null; start(source, j); }, SETTLE_MS);
  }
  return null;
}

function start(source: AudioBuffer, job: Job) {
  if (job.busy || !job.want) return;
  const { key, ...options } = job.want;
  job.want = null;
  if (ready.has(`${job.id} ${key}`)) return;
  job.busy = key;
  started++;
  const done = () => {
    job.busy = null;
    if (!job.timer) start(source, job); // a request that came in meanwhile, settled
  };
  ask(source, options).then((buffer) => {
    const bytes = buffer.length * buffer.numberOfChannels * 4;
    ready.set(`${job.id} ${key}`, { buffer, bytes });
    held += bytes;
    evict();
    done();
    readyListeners.forEach((fn) => fn());
  }, () => { job.failed.add(key); done(); }); // a failed render stays on grains
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
