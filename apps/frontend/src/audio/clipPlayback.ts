// Clip playback shared by the arrangement transport, session launcher and
// freeze rendering, so every clip property sounds the same everywhere.
//
// Clip properties (all optional):
//   gain (dB), transpose (semitones), detune (cents)
//   loopEnabled, loopStart / loopEnd (buffer seconds for audio, clip seconds for MIDI)
//   warpEnabled, warpMode ('beats' | 'tones' | 'texture' | 'repitch'), originalBpm
//
// `duration` is measured in source time (buffer seconds for audio, clip
// seconds for MIDI). A clip consumes `clipRate()` source seconds per
// timeline second, so its arrangement length is duration / rate. With looping
// on, source positions past loopEnd wrap back to loopStart.

import { triggerNote } from './synth';
import { dbToGain } from './devices';

type Stoppable = { stop: (when?: number) => void };

export const clipPitchRate = (clip: any) =>
  Math.pow(2, ((clip.transpose || 0) + (clip.detune || 0) / 100) / 12);

export const isWarped = (clip: any) => !!(clip.warpEnabled && clip.originalBpm && clip.audioBuffer);

// Source seconds consumed per timeline second
export function clipRate(clip: any, bpm: number): number {
  if (clip.type === 'midi') return 1;
  if (isWarped(clip)) {
    const tempoRatio = bpm / clip.originalBpm;
    // Re-Pitch follows tempo by resampling, so transposition stacks on top
    return clip.warpMode === 'repitch' ? tempoRatio * clipPitchRate(clip) : tempoRatio;
  }
  return clipPitchRate(clip); // unwarped audio: transposing changes speed too
}

export const clipTimelineLength = (clip: any, bpm: number) => clip.duration / clipRate(clip, bpm);

export const clipLoop = (clip: any): [number, number] | null => {
  if (!clip.loopEnabled) return null;
  const s = clip.loopStart ?? 0, e = clip.loopEnd ?? 0;
  return e - s > 0.005 ? [s, e] : null;
};

// Source position at `x` timeline seconds into the clip (loop-wrapped)
export function sourcePosAt(clip: any, bpm: number, x: number): number {
  const raw = (clip.type === 'midi' ? 0 : clip.startOffset || 0) + x * clipRate(clip, bpm);
  const loop = clipLoop(clip);
  if (!loop || raw < loop[1]) return raw;
  const len = loop[1] - loop[0];
  return loop[0] + ((raw - loop[1]) % len);
}

// Every note a MIDI clip actually plays, in clip seconds, with transposition
// applied: with looping on, the first pass plays up to loopEnd and then
// [loopStart, loopEnd) repeats until the clip ends.
export function expandMidiNotes(clip: any) {
  const shift = Math.round(clip.transpose || 0);
  const loop = clipLoop(clip);
  const out: { start: number; end: number; pitch: number; velocity: number; id: string }[] = [];
  const add = (n: any, offset: number, limit: number, pass: number) => {
    const s = n.start + offset;
    const e = Math.min(s + n.duration, limit);
    if (e > s) out.push({ start: s, end: e, pitch: n.pitch + shift, velocity: n.velocity ?? 1, id: `${n.id}-${pass}` });
  };
  const notes: any[] = clip.notes || [];
  if (!loop) {
    notes.forEach((n) => add(n, 0, clip.duration, 0));
    return out;
  }
  const [ls, le] = loop;
  const len = le - ls;
  notes.forEach((n) => { if (n.start < le) add(n, 0, Math.min(le, clip.duration), 0); });
  let pass = 1;
  for (let passStart = le; passStart < clip.duration; passStart += len, pass++) {
    const limit = Math.min(passStart + len, clip.duration);
    notes.forEach((n) => { if (n.start >= ls && n.start < le) add(n, passStart - ls, limit, pass); });
  }
  return out;
}

// Grain sizes per warp mode: short for punchy material, long for pads
const WARP_GRAINS: Record<string, { grain: number; jitter: number }> = {
  beats: { grain: 0.05, jitter: 0 },
  tones: { grain: 0.09, jitter: 0 },
  texture: { grain: 0.16, jitter: 0.012 }
};

/**
 * Play the part of `clip` between timeline offsets [from, to) (seconds from
 * the clip's start) beginning at context time `when`, into `dest`.
 * Returns the scheduled nodes so the caller can stop them early.
 */
export function scheduleClip(
  ctx: BaseAudioContext, clip: any, instrumentParams: any, dest: AudioNode,
  when: number, from: number, to: number, bpm: number,
  opts: { noteStartsOnly?: boolean } = {}
): Stoppable[] {
  const sources: Stoppable[] = [];
  if (to <= from) return sources;
  const out = ctx.createGain();
  out.gain.value = dbToGain(clip.gain || 0, -96);
  out.connect(dest);
  const loop = clipLoop(clip);

  if (clip.type === 'midi') {
    if (!instrumentParams || !clip.notes) return sources;
    const occurrences = expandMidiNotes(clip);
    occurrences.forEach((o) => {
      // noteStartsOnly: a caller scheduling a clip in consecutive windows wants
      // each note exactly once (in the window where it starts), at full length
      if (opts.noteStartsOnly && (o.start < from || o.start >= to)) return;
      const a = opts.noteStartsOnly ? o.start : Math.max(from, o.start);
      const b = opts.noteStartsOnly ? o.end : Math.min(to, o.end);
      if (b <= a) return;
      sources.push(triggerNote(ctx, out, instrumentParams, o.pitch, when + (a - from), b - a, o.velocity));
    });
    return sources;
  }

  const buffer: AudioBuffer | undefined = clip.audioBuffer;
  if (!buffer) return sources;
  const rate = clipRate(clip, bpm);

  if (isWarped(clip) && clip.warpMode !== 'repitch') {
    // Granular time-stretch: grains read the source at the tempo ratio and are
    // individually resampled by the transposition, so pitch and time are independent.
    const { grain, jitter } = WARP_GRAINS[clip.warpMode] || WARP_GRAINS.beats;
    const hop = grain / 2;
    const pitch = clipPitchRate(clip);
    for (let x = from; x < to; x += hop) {
      let pos = sourcePosAt(clip, bpm, x);
      if (jitter) pos = Math.max(0, pos + (Math.random() * 2 - 1) * jitter);
      if (pos >= buffer.duration - 0.005) { if (!loop) break; continue; }
      const t = when + (x - from);
      const len = Math.min(grain, to - x); // the last grain stops exactly at `to`
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = pitch;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(1, t + Math.min(hop / 2, len / 2));
      env.gain.setValueAtTime(1, t + Math.max(len - hop / 2, len / 2));
      env.gain.linearRampToValueAtTime(0, t + len);
      src.connect(env);
      env.connect(out);
      src.start(t, pos, Math.min(len * pitch, buffer.duration - pos));
      sources.push(src);
    }
    return sources;
  }

  // Plain playback (unwarped, or Re-Pitch): one resampled source, natively looped
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  if (loop) {
    src.loop = true;
    src.loopStart = loop[0];
    src.loopEnd = loop[1];
  }
  src.connect(out);
  const offset = sourcePosAt(clip, bpm, from);
  if (!loop && offset >= buffer.duration) return sources;
  // start()'s duration counts buffer time, loops included
  src.start(when, offset, (to - from) * rate);
  sources.push(src);
  return sources;
}
