// A track's instrument as the engine worklet plays it: what synth.ts's
// triggerNote and startVoice post for a note when its destination is a
// strip on the live engine. Library notes come from library.ts's renders
// (cached, or rendered in a worker in time, with its accounting); the
// Synth and the Drums are voice specs the worklet builds itself; a
// physical model plays live through liveModels.ts.

import { playsLive } from '@noprod/sound';
import type { Engine } from './engineNode';
import type { VoiceSpec } from './dsp/events';
import { cachedNoteBuffer, libraryOf, nearestNoteBuffer, noteBuffer, resolveLibraryNote, soundRelease, type LibraryNote } from './library';
import { startLiveVoice } from './liveModels';
import { midiToFreq, type SynthParams } from './synth';

type Stoppable = { stop: (when?: number) => void };

// A key let go this long before its render arrives is forgotten (seconds)
const FORGOTTEN = 1.5;

let nextKey = 1;
const key = (prefix: string) => `${prefix}:${nextKey++}`;

const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];

export const synthSpec = (params: SynthParams, midiNote: number, velocity: number): VoiceSpec => ({
  kind: 'synth',
  wave: WAVES.includes(params.Waveform as string) ? (params.Waveform as string) : 'sawtooth',
  hz: midiToFreq(midiNote),
  attack: params.Attack ?? 0.01, decay: params.Decay ?? 0.15, sustain: params.Sustain ?? 0.6, release: params.Release ?? 0.2,
  peak: (params.Gain ?? 0.7) * Math.max(0, Math.min(1, velocity))
});

export const drumSpec = (params: SynthParams, note: number, velocity: number): VoiceSpec => ({
  kind: 'drum', note, tune: params.Tune ?? 0, decay: params.Decay ?? 1,
  level: (params.Gain ?? 0.8) * Math.max(0, Math.min(1, velocity))
});

const bufferSpec = (engine: Engine, r: LibraryNote, buffer: AudioBuffer, rate = 1, gain = 1, release?: number): VoiceSpec => ({
  kind: 'buffer', buf: engine.bufferId(buffer), rate, level: r.level * gain, release,
  ...(r.chokeGroup !== undefined && r.pad !== undefined ? { choke: { group: r.chokeGroup, pad: r.pad } } : {})
});

// A scheduled note on a strip (an audition, the band's notes): see synth.ts triggerNote
export function engineNote(engine: Engine, strip: number, params: SynthParams, midiNote: number, when: number, duration: number, velocity: number): Stoppable {
  const k = key('note');
  const ctx = engine.ctx;
  if (params.Kit === 'library') {
    const r = resolveLibraryNote(params, midiNote, velocity, duration);
    if (!r) return { stop: () => {} };
    let posted = false;
    const handle = noteBuffer(ctx, r, when, (buffer, at) => {
      posted = true;
      engine.notes([{ key: k, strip, at: Math.max(at, ctx.currentTime), voice: bufferSpec(engine, r, buffer), duration }]);
    });
    return { stop: (at) => { if (posted) engine.retract([k], at); else handle.cancel(at); } };
  }
  const voice = params.Kit === 'drums' ? drumSpec(params, midiNote, velocity) : synthSpec(params, midiNote, velocity);
  engine.notes([{ key: k, strip, at: when, voice, duration }]);
  return { stop: (at) => engine.retract([k], at) };
}

// A held voice on a strip, from live input: see synth.ts startVoice
export function engineHeldVoice(engine: Engine, strip: number, params: SynthParams, midiNote: number, when: number, velocity: number): { release: (at: number) => void } {
  const ctx = engine.ctx;
  if (params.Kit === 'drums') {
    engine.liveOn(key('hit'), strip, when, drumSpec(params, midiNote, velocity));
    return { release: () => {} };
  }
  if (params.Kit === 'library') {
    const sound = libraryOf(params)?.sound;
    if (sound && playsLive(sound)) {
      const live = startLiveVoice(ctx, strip, sound, params, midiNote, when, velocity);
      if (live) return live;
    }
    const v = Math.min(1, Math.max(0, velocity));
    const pitched = !!sound?.pitched;
    const r = pitched ? resolveLibraryNote(params, midiNote, 1, sound!.length) : resolveLibraryNote(params, midiNote, velocity);
    if (!r) return { release: () => {} };
    const k = key('held');
    const release = pitched ? soundRelease(sound!) : undefined;
    const gain = pitched ? v * v : 1;
    let posted = false, releasedAt: number | null = null;
    const post = (buffer: AudioBuffer, at: number, rate = 1, nearGain = 1) => {
      posted = true;
      engine.liveOn(k, strip, Math.max(at, ctx.currentTime), bufferSpec(engine, r, buffer, rate, gain * nearGain, release));
      // let go already (a render that came after the key): it plays late,
      // for as long as the key was held
      if (releasedAt !== null) engine.liveOff(k, at + Math.max(0.02, releasedAt - when));
    };
    const hit = cachedNoteBuffer(r, ctx.sampleRate);
    const near = hit ? null : nearestNoteBuffer(r, ctx.sampleRate);
    let handle: { cancel: (at?: number) => void } | null = null;
    if (hit) {
      post(hit, when);
    } else if (near) {
      // the fast path: a rendered neighbour, repitched, while the key's own render comes for next time
      post(near.buffer, when, near.rate, near.gain);
      noteBuffer(ctx, r, Infinity, () => {}, true);
    } else {
      // a render still to come: it plays when it arrives, unless the key was
      // let go so long before that nobody is waiting for it any more
      handle = noteBuffer(ctx, r, when, (buffer, at) => { if (releasedAt === null || at - releasedAt < FORGOTTEN) post(buffer, at); }, true);
    }
    return {
      release(at) {
        if (releasedAt !== null) return;
        releasedAt = at;
        if (posted) engine.liveOff(k, at);
        else if (pitched) setTimeout(() => { if (!posted) handle?.cancel(); }, FORGOTTEN * 1000);
      }
    };
  }
  const k = key('held');
  engine.liveOn(k, strip, when, synthSpec(params, midiNote, velocity));
  return { release: (at) => engine.liveOff(k, at) };
}
