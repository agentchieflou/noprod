// NoProd Synth: a minimal subtractive-style WebAudio voice (oscillator + ADSR).
// One voice per note; the caller owns routing by passing a destination node.

export interface SynthParams {
  Waveform?: OscillatorType | string;
  Attack?: number;   // seconds
  Decay?: number;    // seconds
  Sustain?: number;  // 0..1 fraction of peak
  Release?: number;  // seconds
  Gain?: number;     // 0..1 peak gain
}

export const midiToFreq = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiNoteName = (note: number): string =>
  `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;

// Schedules a single note. Returns the oscillator so callers can force-stop it
// (it self-stops after release otherwise).
export function triggerNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  params: SynthParams,
  midiNote: number,
  when: number,
  duration: number,
  velocity = 1
): OscillatorNode {
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
