// Resynthesis: any recording, described as an arrangement of frequencies.
//
// The inverse of the renderer (spectral modelling synthesis):
//  1. a short-time Fourier transform, frame by frame;
//  2. the spectral peaks in each frame, tracked from frame to frame into
//     partials, each with its frequency, level, attack and decay;
//  3. what the partials don't explain (the residual) as bands of noise, each
//     with its own level and envelope.
// The result is an ordinary recipe: a partials layer plus noise layers. A
// recording with a pitch becomes a pitched sound that plays across the keys.

import { estimatePitch, fft, periodicity } from './analysis.ts';
import { midiToHz } from './dsp.ts';
import type { Category, Layer, Partial, SoundRecipe } from './types.ts';

export interface ResynthOptions {
  id?: string;
  name?: string;
  maxPartials?: number;  // the strongest kept (default 40)
}

interface Peak { hz: number; amp: number }
interface Track { hz: number[]; amp: number[]; first: number; last: number; open: boolean }

const NOISE_BANDS = [60, 250, 700, 1600, 3500, 7000, 14000, 20000];

export function resynthesize(samples: Float32Array, sampleRate: number, options: ResynthOptions = {}): SoundRecipe {
  // Start at the onset: the first sample above -60 dB of the peak
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  let onset = 0;
  while (onset < samples.length && Math.abs(samples[onset]) < peak * 0.001) onset++;
  let end = samples.length;
  while (end > onset && Math.abs(samples[end - 1]) < peak * 0.0001) end--;
  const duration = Math.max(0.05, (end - onset) / sampleRate);

  // The shape of the whole sound, from the waveform in 5 ms steps (the
  // analysis window is too long to see an attack): the attack is the time
  // to 90% of its loudest; it holds while it stays above half of that
  const step = Math.max(1, Math.round(0.005 * sampleRate));
  const shape: { t: number; level: number }[] = [];
  for (let i = onset; i < end; i += step) {
    let s2 = 0;
    for (let j = i; j < Math.min(end, i + step); j++) s2 += samples[j] * samples[j];
    shape.push({ t: (i - onset) / sampleRate, level: Math.sqrt(s2 / step) });
  }
  const whole = fitEnvelope(shape);
  const attack = Math.max(0.001, whole.rise);

  // Short sounds need a short window to keep their time detail
  const size = duration < 0.5 ? 1024 : sampleRate > 50000 ? 8192 : 4096;
  const hop = size / 8;
  const frameTime = hop / sampleRate;
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const windowPower = window.reduce((s, w) => s + w * w, 0);

  // ---- 1. frames: magnitude spectra, centred on onset + f·hop
  const frames: Float64Array[] = [];
  for (let at = onset; at < end; at += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const j = at - size / 2 + i;
      if (j >= 0 && j < samples.length) re[i] = samples[j] * window[i];
    }
    fft(re, im);
    const mag = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    frames.push(mag);
  }
  let loudest = 1e-12;
  for (const m of frames) for (const v of m) loudest = Math.max(loudest, v);

  // ---- 2. peaks, tracked into partials
  const peaksOf = (mag: Float64Array): Peak[] => {
    let frameMax = 0;
    for (const v of mag) frameMax = Math.max(frameMax, v);
    const floor = Math.max(loudest * 3e-4, frameMax * 1e-3); // -70 dB overall, -60 dB in the frame
    const out: Peak[] = [];
    for (let k = 2; k < mag.length - 2; k++) {
      const v = mag[k];
      if (v < floor || v <= mag[k - 1] || v < mag[k + 1] || v <= mag[k - 2] || v < mag[k + 2]) continue;
      // Parabolic interpolation on the log magnitude: frequency and true peak
      const a = Math.log(mag[k - 1] + 1e-20), b = Math.log(v), c = Math.log(mag[k + 1] + 1e-20);
      const p = (0.5 * (a - c)) / (a - 2 * b + c);
      const hz = ((k + p) * sampleRate) / size;
      if (hz < 20 || hz > sampleRate * 0.45) continue;
      out.push({ hz, amp: (Math.exp(b - 0.25 * (a - c) * p) * 4) / size }); // a sine of amplitude A peaks at A·N/4
    }
    return out.sort((x, y) => y.amp - x.amp).slice(0, 80);
  };

  const tracks: Track[] = [];
  const peaksByFrame = frames.map(peaksOf);
  peaksByFrame.forEach((peaks, f) => {
    const taken = new Set<Track>();
    for (const pk of peaks) {
      let best: Track | null = null;
      let distance = Infinity;
      for (const t of tracks) {
        if (!t.open || taken.has(t) || f - t.last > 2) continue;
        const d = Math.abs(t.hz[t.hz.length - 1] - pk.hz);
        if (d < Math.max(4, pk.hz * 0.012) && d < distance) { best = t; distance = d; }
      }
      if (best) {
        best.hz.push(pk.hz); best.amp.push(pk.amp); best.last = f;
        taken.add(best);
      } else {
        const t: Track = { hz: [pk.hz], amp: [pk.amp], first: f, last: f, open: true };
        tracks.push(t);
        taken.add(t);
      }
    }
    for (const t of tracks) if (t.open && f - t.last > 2) t.open = false;
  });

  const energy = (t: Track) => t.amp.reduce((s, a) => s + a * a, 0);
  const kept = tracks
    .filter((t) => t.amp.length >= 3)
    .sort((a, b) => energy(b) - energy(a))
    .slice(0, options.maxPartials ?? 40);

  // ---- pitch: periodic at the YIN estimate, measured where it's loudest
  const loudestFrame = frames.reduce((best, m, f) => (sum(m) > sum(frames[best]) ? f : best), 0);
  const at = Math.min(Math.max(0, onset + loudestFrame * hop), Math.max(0, samples.length - 4096));
  const f0 = estimatePitch(samples, sampleRate, at, 4096, 30, 4000);
  const pitched = f0 > 0 && periodicity(samples, sampleRate, f0, at, 4096) < 0.2
    && kept.some((t) => Math.abs(median(t.hz) / f0 - 1) < 0.03);
  const root = pitched ? Math.round(69 + 12 * Math.log2(f0 / 440)) : 60;

  // ---- partials: each track's frequency, peak, attack and decay
  const base = pitched ? midiToHz(root) : Math.min(...kept.map((t) => median(t.hz)), 20000);
  const partials: Partial[] = kept.map((t) => {
    const env = fitEnvelope(t.amp.map((a, i) => ({ t: (t.first + i) * frameTime, level: a })));
    // A partial that swells in well after the sound's attack fades in on its own
    const late = env.rise > attack + 0.08;
    // The renderer decays a partial from the start: its level there, on the fitted decay
    const level = !env.decay ? env.peak
      : late ? Math.min(env.peak * 4, env.peak / Math.exp((-Math.log(1000) * env.rise) / env.decay)) : env.levelAt(0);
    const partial: Partial = { ratio: round(median(t.hz) / base, 4), level: round(level, 4) };
    if (env.decay) partial.decay = round(env.decay, 3);
    if (late) partial.attack = round(env.rise, 3);
    return partial;
  }).sort((a, b) => a.ratio - b.ratio);

  // Something held: a pitched sound sustains for the note (its length is how
  // long the recording held), then releases as the recording did; a one-shot
  // holds that long by itself
  function heldEnvelope(from: number) {
    const hold = Math.max(0, whole.holdEnd - from);
    return pitched
      ? { attack: round(from, 3), sustain: 1, release: round(whole.release, 3) }
      : { attack: round(from, 3), hold: round(hold, 3), decay: round(whole.release, 3), sustain: 0 };
  }

  // ---- 3. the residual, as noise bands
  const nyquist = sampleRate / 2;
  const edges = NOISE_BANDS.filter((e) => e < nyquist * 0.95);
  const bandLevels = edges.slice(0, -1).map(() => [] as { t: number; level: number }[]);
  frames.forEach((mag, f) => {
    // leave out the bins around this frame's tracked peaks
    const masked = new Uint8Array(mag.length);
    for (const t of kept) {
      if (f < t.first || f > t.last) continue;
      const hz = t.hz[Math.min(t.hz.length - 1, f - t.first)];
      const k = Math.round((hz * size) / sampleRate);
      for (let j = Math.max(0, k - 4); j <= Math.min(mag.length - 1, k + 4); j++) masked[j] = 1;
    }
    for (let b = 0; b < edges.length - 1; b++) {
      const lo = Math.ceil((edges[b] * size) / sampleRate), hi = Math.floor((edges[b + 1] * size) / sampleRate);
      let power = 0, counted = 0;
      for (let k = lo; k <= hi; k++) if (!masked[k]) { power += mag[k] * mag[k]; counted++; }
      // the masked bins stand for as much again; time-domain RMS by Parseval
      const full = counted ? (power * (hi - lo + 1)) / counted : 0;
      bandLevels[b].push({ t: f * frameTime, level: Math.sqrt((2 * full) / (size * windowPower)) });
    }
  });
  const partialPeak = Math.max(1e-9, ...partials.map((p) => p.level));
  const noise: Layer[] = [];
  bandLevels.forEach((levels, b) => {
    const env = fitEnvelope(levels);
    if (env.peak < partialPeak * 0.01 && partials.length) return; // below -40 dB of the partials: leave it out
    if (env.peak < 1e-5) return;
    const lo = edges[b], hi = edges[b + 1];
    const centre = Math.sqrt(lo * hi);
    const bandAttack = env.rise > attack + 0.08 ? env.rise : attack;
    const level = env.decay ? env.levelAt(bandAttack) : env.peak; // the envelope decays from the end of its attack
    // White noise (variance 1/3) through a unity-peak bandpass keeps π/2·(hi-lo) of nyquist's worth of it
    const kept = (Math.PI / 2) * (hi - lo) / nyquist / 3;
    noise.push({
      type: 'noise',
      level: round(level / Math.sqrt(kept), 4),
      filter: { type: 'bandpass', cutoff: Math.round(centre), q: round(centre / (hi - lo), 3), keyTrack: pitched ? 1 : 0 },
      env: env.decay ? { attack: round(bandAttack, 3), decay: round(env.decay, 3), sustain: 0, release: 0.1 } : heldEnvelope(bandAttack)
    });
  });

  // ---- the recipe
  const layers: Layer[] = [];
  if (partials.length) {
    layers.push({
      type: 'partials', partials, phases: 'random',
      ...(pitched ? {} : { hz: round(base, 3) }),
      env: whole.held ? heldEnvelope(attack) : { attack: round(attack, 3), sustain: 1, release: 0.15 }
    });
  }
  layers.push(...noise);
  const name = options.name ?? 'Resynthesized';
  const category: Category = pitched ? (f0 < 130 ? 'bass' : 'keys') : duration < 1.5 ? 'percussion' : 'fx';
  return {
    id: options.id ?? `resynth-${Math.round(duration * 1000)}-${Math.round(base)}`,
    name, category, tags: ['resynthesized'], pitched, root,
    length: round(pitched && whole.held ? Math.max(0.05, whole.holdEnd) : duration + (pitched ? 0 : 0.1), 3),
    layers: layers.length ? layers : [{ type: 'noise', level: 0, env: { decay: 0.01, sustain: 0 } }]
  };
}

// How close a recipe comes to a recording: the mean difference in dB between
// their spectrograms, over the parts of the recording within 60 dB of its
// loudest (lower is closer)
export function spectralDistance(a: Float32Array, b: Float32Array, sampleRate: number, size = 2048) {
  const hop = size / 4;
  const frames = Math.floor((Math.max(a.length, b.length) - size) / hop);
  const spectra = (x: Float32Array) => Array.from({ length: Math.max(0, frames) }, (_, f) => {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const v = x[f * hop + i] ?? 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    }
    fft(re, im);
    return Float64Array.from({ length: size / 2 }, (_, k) => 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-9));
  });
  const sa = spectra(a), sb = spectra(b);
  let top = -Infinity;
  for (const m of sa) for (const v of m) top = Math.max(top, v);
  let total = 0, count = 0;
  sa.forEach((m, f) => m.forEach((v, k) => {
    if (v < top - 60) return;
    total += Math.abs(v - Math.max(sb[f][k], top - 80));
    count++;
  }));
  void sampleRate;
  return count ? total / count : 0;
}

// --------------------------------------------------------------- helpers

const sum = (m: Float64Array) => { let s = 0; for (const v of m) s += v * v; return s; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const round = (x: number, digits: number) => Number(x.toPrecision(digits));

// A level over time, as the renderer's envelope sees it. It rises to 90% of
// its peak by `rise`. It's `held` if it then stays above half its peak for a
// while without falling more than 6 dB a second (its level is the median
// there, and `holdEnd` when it drops below half; `release` is the T60 of what
// follows). Otherwise it decays: `decay` is the T60 fitted from the peak down
// to -50 dB, and `levelAt` that line's level at any time.
function fitEnvelope(points: { t: number; level: number }[]) {
  let peak = 0, peakIndex = 0;
  points.forEach((p, i) => { if (p.level > peak) { peak = p.level; peakIndex = i; } });
  const riseIndex = Math.max(0, points.findIndex((p) => p.level >= peak * 0.9));
  const rise = points[riseIndex]?.t ?? 0;
  let lastAbove = riseIndex;
  points.forEach((p, i) => { if (p.level >= peak * 0.5) lastAbove = i; });
  const holdEnd = points[lastAbove]?.t ?? rise;
  const holding = points.slice(riseIndex, lastAbove + 1);
  const holdSlope = slopeOf(holding.map((p) => ({ t: p.t, db: 20 * Math.log10(Math.max(p.level, 1e-12) / peak) }))).slope;
  const tail = points.slice(lastAbove).filter((p) => p.level > peak * 0.001).map((p) => ({ t: p.t, db: 20 * Math.log10(p.level / peak) }));
  const tailSlope = tail.length >= 3 ? slopeOf(tail).slope : -Infinity;
  const release = Math.min(10, Math.max(0.02, tailSlope < -1 ? -60 / tailSlope : 0.05));

  if (holding.length >= 3 && holdEnd - rise >= 0.15 && holdSlope > -6) {
    const level = median(holding.map((p) => p.level));
    return { peak: level, rise, held: true, holdEnd, release, decay: undefined as number | undefined, levelAt: (_t: number) => level };
  }
  const falling = points.slice(peakIndex).filter((p) => p.level > peak * 0.003).map((p) => ({ t: p.t, db: 20 * Math.log10(p.level / peak) }));
  let decay: number | undefined;
  let levelAt = (_t: number) => peak;
  if (falling.length >= 3) {
    const { slope, mt, md } = slopeOf(falling);
    if (slope < -1) {
      decay = Math.min(60, -60 / slope);
      // never more than 4x the measured peak, whatever the line says
      levelAt = (t: number) => Math.min(peak * 4, peak * Math.pow(10, (md + slope * (t - mt)) / 20));
    }
  }
  return { peak, rise, held: false, holdEnd, release, decay, levelAt };
}

// Least-squares line through dB against time: its slope (dB/s) and centre
function slopeOf(points: { t: number; db: number }[]) {
  const n = points.length;
  if (n < 2) return { slope: 0, mt: points[0]?.t ?? 0, md: points[0]?.db ?? 0 };
  const mt = points.reduce((s, p) => s + p.t, 0) / n, md = points.reduce((s, p) => s + p.db, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.db - md); den += (p.t - mt) * (p.t - mt); }
  return { slope: den > 0 ? num / den : 0, mt, md };
}
