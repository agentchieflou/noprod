// Tempo Following: listens to an audio input, tracks its tempo in real time
// and (when Follow is on) keeps the project tempo locked to it.
//
// The onset worklet produces an onset-strength envelope (one value per 256
// samples). Every half second the last 8s of it are smoothed and
// autocorrelated over the lags of 60-190 BPM; a broad prior centred on 120
// BPM plus a half-time check steer away from half/double-tempo errors, and
// parabolic interpolation refines the peak.

import { audioContext } from './engine';
import { openAudioInput } from './inputs';

const HOP = 256;
const WINDOW_SEC = 8;
const ANALYZE_MS = 500;
const MIN_BPM = 60;
const MAX_BPM = 190;

export interface FollowerState {
  listening: boolean;
  detectedBpm: number | null;
  confidence: number;      // 0..1
}

let state: FollowerState = { listening: false, detectedBpm: null, confidence: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<FollowerState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
export const subscribeFollower = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getFollowerState = () => state;

let node: AudioWorkletNode | null = null;
let source: AudioNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let env = new Float32Array(0);
let filled = 0;
let smoothed: number | null = null;
let onTempo: ((bpm: number) => void) | null = null;

const sink = audioContext.createGain();
sink.gain.value = 0;
sink.connect(audioContext.destination);

export async function startFollowing(deviceId: string, channel: string, apply: (bpm: number) => void) {
  stopFollowing();
  onTempo = apply;
  const open = await openAudioInput(deviceId);
  if (!open) { set({ listening: false }); return false; }
  const hopsPerWindow = Math.round((WINDOW_SEC * audioContext.sampleRate) / HOP);
  env = new Float32Array(hopsPerWindow);
  filled = 0;
  smoothed = null;
  node = new AudioWorkletNode(audioContext, 'noprod-onset', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  node.port.onmessage = (e) => {
    const batch: Float32Array = e.data;
    // ring-less sliding window: shift left, append
    env.copyWithin(0, batch.length);
    env.set(batch, env.length - batch.length);
    filled = Math.min(env.length, filled + batch.length);
  };
  source = open.outputs[channel] || open.outputs['1/2'];
  source.connect(node);
  node.connect(sink);
  timer = setInterval(analyze, ANALYZE_MS);
  set({ listening: true, detectedBpm: null, confidence: 0 });
  return true;
}

export function stopFollowing() {
  if (timer) clearInterval(timer);
  timer = null;
  if (source && node) { try { source.disconnect(node); } catch { /* not connected */ } }
  node?.disconnect();
  node = null;
  source = null;
  onTempo = null;
  if (state.listening) set({ listening: false });
}

// Tempo estimate from an onset envelope (exported for testing/offline use)
export function estimateTempo(envelope: Float32Array, hopSec: number): { bpm: number; confidence: number } | null {
  const n = envelope.length;
  // Widen the onset peaks (~35ms triangle) so beat periods that fall between
  // two whole hops still correlate fully (130 BPM = 86.5 hops)
  const KERNEL = [1, 2, 3, 4, 3, 2, 1];
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < KERNEL.length; k++) acc += envelope[Math.min(n - 1, Math.max(0, i + k - 3))] * KERNEL[k];
    smooth[i] = acc / 16;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += smooth[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = smooth[i] - mean;
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += x[i] * x[i];
  if (r0 < 1e-9) return null;

  const lagMin = Math.floor(60 / MAX_BPM / hopSec);
  const lagMax = Math.ceil(60 / MIN_BPM / hopSec);
  // up to 2x the longest period, so every candidate gets its harmonic term
  const acf = new Float32Array(2 * lagMax + 2);
  for (let lag = lagMin - 1; lag <= 2 * lagMax + 1 && lag < n; lag++) {
    let r = 0;
    for (let i = 0; i + lag < n; i++) r += x[i] * x[i + lag];
    acf[lag] = r / (n - lag);
  }
  // Strongest periodicity, weighted toward ~120 BPM and rewarding periods
  // whose double also correlates (a steady pulse, not a one-off echo)
  const scoreAt = (lag: number) => {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    return (acf[lag] + 0.5 * acf[2 * lag]) * prior;
  };
  let best = -1, bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const score = scoreAt(lag);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || acf[best] <= 0) return null;
  // Half-time check: if there is an event on every half of this period too,
  // the faster pulse is the beat (e.g. 170 rather than 85)
  for (let tries = 0; tries < 2; tries++) {
    const half = Math.round(best / 2);
    let peak = half;
    for (let l = half - 1; l <= half + 1; l++) if (l >= lagMin && acf[l] > acf[peak]) peak = l;
    if (peak >= lagMin && acf[peak] >= 0.8 * acf[best]) best = peak; else break;
  }
  // parabolic interpolation around the peak
  const a = acf[best - 1], b = acf[best], c = acf[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
  const lag = best + shift;
  return { bpm: 60 / (lag * hopSec), confidence: Math.max(0, Math.min(1, (acf[best] * n) / r0)) };
}

function analyze() {
  if (filled < env.length * 0.5) return; // need ~4s of signal first
  const hopSec = HOP / audioContext.sampleRate;
  const est = estimateTempo(env.subarray(env.length - filled), hopSec);
  if (!est || est.confidence < 0.05) { set({ confidence: est?.confidence ?? 0 }); return; }
  // Smooth small drifts; jump straight to a clearly different tempo
  smoothed = smoothed === null || Math.abs(est.bpm - smoothed) > 8 ? est.bpm : smoothed * 0.6 + est.bpm * 0.4;
  const bpm = Math.round(smoothed * 10) / 10;
  set({ detectedBpm: bpm, confidence: est.confidence });
  onTempo?.(bpm);
}
