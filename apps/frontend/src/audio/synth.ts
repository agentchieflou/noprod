// NoProd Synth: a minimal subtractive-style WebAudio voice (oscillator + ADSR).
// One voice per note; the caller owns routing by passing a destination node.
// Library instruments (Kit 'library', see library.ts) play from here too.

import { triggerLibrary, startLibraryVoice, type LibraryInstrument } from './library';

export interface SynthParams {
  Waveform?: OscillatorType | string;
  Attack?: number;   // seconds
  Decay?: number;    // seconds
  Sustain?: number;  // 0..1 fraction of peak
  Release?: number;  // seconds
  Gain?: number;     // 0..1 peak gain
  Kit?: string;      // 'drums' = NoProd Drums kit, 'library' = a library sound or kit
  Tune?: number;     // drums and library: semitones
  Library?: LibraryInstrument;
}

export const midiToFreq = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiNoteName = (note: number): string =>
  `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;

// ------------------------------------------------------------- NoProd Drums
// A synthesized General-MIDI-style kit: 36 kick, 38 snare, 39 clap, 42/44
// closed hat, 46 open hat, 49/57 crash, 41-50 toms; other notes play a tom
// at their own pitch. Decay scales every envelope, Tune shifts pitched parts.

export const DRUM_NAMES: Record<number, string> = {
  36: 'Kick', 38: 'Snare', 39: 'Clap', 42: 'Closed Hat', 46: 'Open Hat', 49: 'Crash', 45: 'Low Tom', 48: 'High Tom'
};

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
const noiseBuffer = (ctx: BaseAudioContext) => {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
};

function triggerDrum(
  ctx: BaseAudioContext, destination: AudioNode, params: SynthParams, note: number, when: number, velocity: number
): AudioScheduledSourceNode {
  const decay = params.Decay ?? 1;
  const tune = Math.pow(2, (params.Tune ?? 0) / 12);
  const level = (params.Gain ?? 0.8) * Math.max(0, Math.min(1, velocity));
  const out = ctx.createGain();
  out.connect(destination);
  const env = (g: GainNode, peak: number, len: number, at = when) => {
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.01, len * decay));
  };
  const noise = (len: number, filter: BiquadFilterType, freq: number, q = 0.7, peak = 1, at = when) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filter; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    env(g, peak * level, len, at);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(at, Math.random()); src.stop(at + len * decay + 0.05);
    return src;
  };
  const tone = (type: OscillatorType, f0: number, f1: number, sweep: number, len: number, peak = 1) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * tune, when);
    osc.frequency.exponentialRampToValueAtTime(f1 * tune, when + sweep);
    const g = ctx.createGain();
    env(g, peak * level, len);
    osc.connect(g); g.connect(out);
    osc.start(when); osc.stop(when + len * decay + 0.05);
    return osc;
  };
  switch (note) {
    case 35: case 36: return tone('sine', 150, 45, 0.12, 0.45, 1.2);
    case 38: case 40: tone('triangle', 190, 160, 0.05, 0.12, 0.6); return noise(0.2, 'bandpass', 1900, 0.8, 0.9);
    case 39: [0, 0.012, 0.026].forEach((d) => noise(0.08, 'bandpass', 1200, 1.2, 0.7, when + d)); return noise(0.25, 'bandpass', 1200, 1.2, 0.6, when + 0.04);
    case 42: case 44: return noise(0.05, 'highpass', 7500, 0.7, 0.5);
    case 46: return noise(0.35, 'highpass', 7000, 0.7, 0.45);
    case 49: case 57: return noise(1.4, 'highpass', 5000, 0.7, 0.4);
    default: {
      const f = 440 * Math.pow(2, (note - 69) / 12);
      return tone('sine', f * 1.6, f, 0.08, 0.35, 0.9);
    }
  }
}

// Schedules a single note. Returns the main source so callers can force-stop
// it (it self-stops after release otherwise).
export function triggerNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  params: SynthParams,
  midiNote: number,
  when: number,
  duration: number,
  velocity = 1
): AudioScheduledSourceNode {
  if (params.Kit === 'drums') return triggerDrum(ctx, destination, params, midiNote, when, velocity);
  if (params.Kit === 'library') return triggerLibrary(ctx, destination, params, midiNote, when, duration, velocity);
  const osc = ctx.createOscillator();
  const validTypes = ['sine', 'square', 'sawtooth', 'triangle'];
  osc.type = (validTypes.includes(params.Waveform as string) ? params.Waveform : 'sawtooth') as OscillatorType;
  osc.frequency.value = midiToFreq(midiNote);

  const env = ctx.createGain();
  const attack = params.Attack ?? 0.01;
  const decay = params.Decay ?? 0.15;
  const sustain = params.Sustain ?? 0.6;
  const release = params.Release ?? 0.2;
  const peak = (params.Gain ?? 0.7) * Math.max(0, Math.min(1, velocity));

  const holdEnd = Math.max(when + attack + decay, when + duration);
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + attack);
  env.gain.linearRampToValueAtTime(peak * sustain, when + attack + decay);
  env.gain.setValueAtTime(peak * sustain, holdEnd);
  env.gain.linearRampToValueAtTime(0, holdEnd + release);

  osc.connect(env);
  env.connect(destination);
  osc.start(when);
  osc.stop(holdEnd + release + 0.05);
  return osc;
}

// A held voice for live playing (MIDI input): sounds until release().
export function startVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  params: SynthParams,
  midiNote: number,
  when: number,
  velocity = 1
): { release: (at: number) => void } {
  if (params.Kit === 'drums') {
    // drum hits are one-shots: nothing to hold or release
    triggerDrum(ctx, destination, params, midiNote, when, velocity);
    return { release: () => {} };
  }
  if (params.Kit === 'library') return startLibraryVoice(ctx, destination, params, midiNote, when, velocity);
  const osc = ctx.createOscillator();
  const validTypes = ['sine', 'square', 'sawtooth', 'triangle'];
  osc.type = (validTypes.includes(params.Waveform as string) ? params.Waveform : 'sawtooth') as OscillatorType;
  osc.frequency.value = midiToFreq(midiNote);
  const env = ctx.createGain();
  const attack = params.Attack ?? 0.01;
  const decay = params.Decay ?? 0.15;
  const sustain = params.Sustain ?? 0.6;
  const release = params.Release ?? 0.2;
  const peak = (params.Gain ?? 0.7) * Math.max(0, Math.min(1, velocity));
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + attack);
  env.gain.linearRampToValueAtTime(peak * sustain, when + attack + decay);
  osc.connect(env);
  env.connect(destination);
  osc.start(when);
  let released = false;
  return {
    release(at: number) {
      if (released) return;
      released = true;
      const t = Math.max(at, ctx.currentTime);
      // hold whatever level the envelope has reached, then fade out
      const g: any = env.gain;
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
      else g.cancelScheduledValues(t);
      env.gain.linearRampToValueAtTime(0, t + release);
      osc.stop(t + release + 0.05);
    }
  };
}
