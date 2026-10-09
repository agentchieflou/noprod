// Audio-to-MIDI conversion (Live 12's Melody / Drums / Harmony modes).
//
// The clip is first rendered exactly as it plays (gain, transposition, warp,
// loop) so the MIDI lines up with what you hear, then analysed:
// - Melody: YIN pitch tracking -> median-smoothed MIDI pitch -> notes split
//   on pitch changes and re-attacks.
// - Drums: onset detection, each hit classified kick / snare / hi-hat (open
//   or closed) from its low / mid / high band energy and its decay.
// - Harmony: harmonic-sum pitch salience on FFT frames -> up to four
//   simultaneous pitches per frame -> notes from stable runs.
// Notes come back in seconds from the clip start.

import { scheduleClip, clipTimelineLength } from './clipPlayback';

export type ConvertMode = 'melody' | 'drums' | 'harmony';

export interface ConvertedNote { pitch: number; start: number; duration: number; velocity: number }

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

async function renderClip(clip: any, bpm: number, sampleRate: number): Promise<Float32Array> {
  const length = clipTimelineLength(clip, bpm);
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(length * sampleRate)), sampleRate);
  scheduleClip(ctx, clip, null, ctx.destination, 0, 0, length, bpm);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

const rms = (x: Float32Array, from: number, len: number) => {
  let acc = 0;
  const end = Math.min(x.length, from + len);
  for (let i = from; i < end; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, end - from));
};

const median = (vals: number[]) => {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ------------------------------------------------------------------ melody

// YIN fundamental estimate for one frame, or null when unpitched
function yin(x: Float32Array, start: number, w: number, tauMin: number, tauMax: number, threshold = 0.15): number | null {
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const diff = x[start + j] - x[start + j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // cumulative mean normalised difference
  let running = 0;
  const cm = new Float32Array(tauMax + 2);
  cm[0] = 1;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau];
    cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (cm[t] < cm[best]) best = t;
    if (cm[best] > 0.3) return null;
    tau = best;
  }
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const den = a - 2 * b + c;
  return tau + (den !== 0 ? 0.5 * (a - c) / den : 0);
}

async function melody(x: Float32Array, sr: number): Promise<ConvertedNote[]> {
  const W = 768, HOP = Math.round(sr * 0.01);
  const tauMin = Math.floor(sr / 1000), tauMax = Math.ceil(sr / 55);
  const frames = Math.max(0, Math.floor((x.length - W - tauMax - 2) / HOP));
  const level: number[] = [];
  const pitch: number[] = [];
  let maxLevel = 0;
  for (let i = 0; i < frames; i++) {
    const l = rms(x, i * HOP, W);
    level.push(l);
    maxLevel = Math.max(maxLevel, l);
  }
  const gate = Math.max(0.003, maxLevel * 0.08);
  for (let i = 0; i < frames; i++) {
    if (i % 200 === 0) await yieldToUi();
    if (level[i] < gate) { pitch.push(-1); continue; }
    const tau = yin(x, i * HOP, W, tauMin, tauMax);
    pitch.push(tau ? Math.round(69 + 12 * Math.log2(sr / tau / 440)) : -1);
  }
  // 5-frame median removes octave blips and single-frame dropouts
  const smooth = pitch.map((_, i) => median(pitch.slice(Math.max(0, i - 2), i + 3)));
  const notes: ConvertedNote[] = [];
  let cur: { pitch: number; start: number; peak: number } | null = null;
  const close = (end: number) => {
    if (cur && (end - cur.start) * HOP / sr >= 0.05) {
      notes.push({ pitch: cur.pitch, start: cur.start * HOP / sr, duration: (end - cur.start) * HOP / sr, velocity: Math.max(0.3, Math.min(1, cur.peak / maxLevel)) });
    }
    cur = null;
  };
  for (let i = 0; i < frames; i++) {
    const p = smooth[i];
    const reattack = cur && i >= 3 && level[i] > 1.8 * level[i - 3] && level[i] > gate * 2;
    if (p < 0) { close(i); continue; }
    if (!cur || cur.pitch !== p || reattack) { close(i); cur = { pitch: p, start: i, peak: level[i] }; }
    else cur.peak = Math.max(cur.peak, level[i]);
  }
  close(frames);
  return notes;
}

// ------------------------------------------------------------------- drums

const onePoleLowpass = (x: Float32Array, sr: number, fc: number) => {
  const y = new Float32Array(x.length);
  const a = Math.exp(-2 * Math.PI * fc / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s1 = (1 - a) * x[i] + a * s1;
    s2 = (1 - a) * s1 + a * s2; // two poles for a steeper split
    y[i] = s2;
  }
  return y;
};

async function drums(x: Float32Array, sr: number): Promise<ConvertedNote[]> {
  const low = onePoleLowpass(x, sr, 150);
  const belowHigh = onePoleLowpass(x, sr, 5000);
  const high = new Float32Array(x.length);
  const mid = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { high[i] = x[i] - belowHigh[i]; mid[i] = belowHigh[i] - low[i]; }
  await yieldToUi();

  // 5ms hops over a 25ms window: long enough that a kick's 50 Hz body
  // doesn't ripple the envelope into extra onsets
  const HOP = Math.round(sr * 0.005), W = HOP * 5;
  const frames = Math.floor((x.length - W) / HOP);
  const env: number[] = [];
  for (let i = 0; i < frames; i++) env.push(rms(x, i * HOP, W));
  const flux = env.map((v, i) => Math.max(0, v - (i ? env[i - 1] : 0)));
  const maxFlux = Math.max(...flux, 1e-9);

  const notes: ConvertedNote[] = [];
  const minGap = Math.round(0.07 * sr / HOP);
  let last = -minGap;
  for (let i = 0; i < frames - 1; i++) {
    // adaptive threshold: local median + a fraction of the strongest hit
    const local = median(flux.slice(Math.max(0, i - 50), i + 50));
    if (flux[i] < local * 2 + maxFlux * 0.05 || flux[i] < (flux[i - 1] ?? 0) || flux[i] < flux[i + 1] || i - last < minGap) continue;
    last = i;
    // refine to the sample: first point in the window reaching 30% of its peak
    let peakAbs = 0;
    for (let k = i * HOP; k < Math.min(x.length, i * HOP + W + HOP); k++) peakAbs = Math.max(peakAbs, Math.abs(x[k]));
    let at = i * HOP;
    while (at < x.length - 1 && Math.abs(x[at]) < 0.3 * peakAbs) at++;
    const span = Math.round(0.05 * sr);
    const eL = rms(low, at, span), eM = rms(mid, at, span), eH = rms(high, at, span);
    const total = eL + eM + eH + 1e-9;
    // kick: low and no top end; hat: highs with little body; snare: the rest
    let pitch = 38;
    if (eL / total > 0.3 && eH / total < 0.1) pitch = 36;
    else if (eH / total > 0.55 && eM / total < 0.3 && eL / total < 0.15) {
      // open hat if it rings on
      const tail = rms(high, at + Math.round(0.15 * sr), span);
      pitch = tail > eH * 0.3 ? 46 : 42;
    }
    notes.push({ pitch, start: at / sr, duration: 0.1, velocity: Math.max(0.3, Math.min(1, flux[i] / maxFlux)) });
  }
  return notes;
}

// ----------------------------------------------------------------- harmony

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

async function harmony(x: Float32Array, sr: number): Promise<ConvertedNote[]> {
  const N = 4096, HOP = 2048, LO = 36, HI = 84;
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const levels: number[] = [];
  for (let f = 0; f < frames; f++) levels.push(rms(x, f * HOP, N));
  const gate = Math.max(0.003, Math.max(...levels, 0) * 0.08);
  const active: Set<number>[] = [];
  const strength: Map<number, number>[] = [];

  for (let f = 0; f < frames; f++) {
    if (f % 20 === 0) await yieldToUi();
    const set = new Set<number>();
    const str = new Map<number, number>();
    active.push(set);
    strength.push(str);
    if (levels[f] < gate) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[f * HOP + i] * hann[i];
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    const at = (hz: number) => {
      const b = Math.round(hz * N / sr);
      return b < 1 || b >= N / 2 - 1 ? 0 : Math.max(mag[b - 1], mag[b], mag[b + 1]);
    };
    let peakMag = 0;
    for (let i = 1; i < N / 2; i++) if (mag[i] > peakMag) peakMag = mag[i];
    const sal: number[] = [];
    for (let p = LO; p <= HI; p++) {
      const f0 = 440 * Math.pow(2, (p - 69) / 12);
      // a note needs energy at its own fundamental: this rejects the
      // sub-octave "ghosts" that harmonic summation otherwise favours
      if (at(f0) < 0.12 * peakMag) { sal.push(0); continue; }
      let s = 0;
      for (let h = 1; h <= 5; h++) s += at(f0 * h) * Math.pow(0.8, h - 1);
      sal.push(s);
    }
    const max = Math.max(...sal);
    if (max <= 0) continue;
    // peaks above 45% of the strongest, minus the harmonics of stronger notes
    const peaks = sal
      .map((s, i) => ({ p: i + LO, s }))
      .filter(({ s }, i) => s >= 0.45 * max && s >= (sal[i - 1] ?? 0) && s >= (sal[i + 1] ?? 0))
      .sort((a, b) => b.s - a.s);
    const chosen: { p: number; s: number }[] = [];
    peaks.forEach((c) => {
      if (chosen.length >= 4) return;
      const isHarmonic = chosen.some((k) => [12, 19, 24, 28].includes(c.p - k.p) && c.s < 0.9 * k.s);
      if (!isHarmonic) chosen.push(c);
    });
    chosen.forEach(({ p, s }) => { set.add(p); str.set(p, s / max); });
  }

  // a pitch sounds while present in 3 of the 5 neighbouring frames
  const on = (f: number, p: number) =>
    [f - 2, f - 1, f, f + 1, f + 2].filter((k) => k >= 0 && k < frames && active[k].has(p)).length >= 3;
  const notes: ConvertedNote[] = [];
  for (let p = LO; p <= HI; p++) {
    let start = -1, peak = 0;
    for (let f = 0; f <= frames; f++) {
      const isOn = f < frames && on(f, p);
      if (isOn) {
        if (start < 0) { start = f; peak = 0; }
        peak = Math.max(peak, strength[f].get(p) || 0);
      } else if (start >= 0) {
        if (f - start >= 3) notes.push({ pitch: p, start: start * HOP / sr, duration: (f - start) * HOP / sr, velocity: Math.max(0.3, Math.min(1, peak)) });
        start = -1;
      }
    }
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// --------------------------------------------------------------------- api

export async function convertClipToMidi(clip: any, mode: ConvertMode, bpm: number): Promise<ConvertedNote[]> {
  const sr = mode === 'melody' ? 16000 : mode === 'harmony' ? 22050 : 44100;
  const x = await renderClip(clip, bpm, sr);
  if (mode === 'melody') return melody(x, sr);
  if (mode === 'drums') return drums(x, sr);
  return harmony(x, sr);
}
