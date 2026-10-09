// Instrument presets shown in the Browser's Sounds and Drums categories.

import { createDefaultInstrument, createDrumKit } from '../store/useDAWStore';

const synth = (name: string, parameters: Record<string, any>) => ({ ...createDefaultInstrument(), name: 'NoProd Synth', preset: name, parameters });
const kit = (name: string, parameters: Record<string, any>) => ({ ...createDrumKit(), preset: name, parameters: { Kit: 'drums', ...parameters } });

export const SOUND_PRESETS = [
  { name: 'Saw Lead', make: () => synth('Saw Lead', { Waveform: 'sawtooth', Attack: 0.005, Decay: 0.2, Sustain: 0.7, Release: 0.15, Gain: 0.6 }) },
  { name: 'Square Bass', make: () => synth('Square Bass', { Waveform: 'square', Attack: 0.005, Decay: 0.15, Sustain: 0.5, Release: 0.08, Gain: 0.7 }) },
  { name: 'Sine Sub', make: () => synth('Sine Sub', { Waveform: 'sine', Attack: 0.01, Decay: 0.1, Sustain: 0.9, Release: 0.1, Gain: 0.9 }) },
  { name: 'Soft Pad', make: () => synth('Soft Pad', { Waveform: 'triangle', Attack: 0.6, Decay: 0.5, Sustain: 0.8, Release: 1, Gain: 0.5 }) },
  { name: 'Pluck', make: () => synth('Pluck', { Waveform: 'sawtooth', Attack: 0.002, Decay: 0.25, Sustain: 0, Release: 0.1, Gain: 0.7 }) },
  { name: 'Organ', make: () => synth('Organ', { Waveform: 'square', Attack: 0.01, Decay: 0.05, Sustain: 1, Release: 0.05, Gain: 0.4 }) }
];

export const DRUM_KIT_PRESETS = [
  { name: 'NoProd Kit', make: () => kit('NoProd Kit', { Tune: 0, Decay: 1, Gain: 0.8 }) },
  { name: 'Tight Kit', make: () => kit('Tight Kit', { Tune: 2, Decay: 0.5, Gain: 0.8 }) },
  { name: 'Boom Kit', make: () => kit('Boom Kit', { Tune: -4, Decay: 1.8, Gain: 0.85 }) },
  { name: 'Lo-Fi Kit', make: () => kit('Lo-Fi Kit', { Tune: -1, Decay: 0.75, Gain: 0.7 }) }
];

// Library files that look like drum hits / loops
export const isDrumSample = (path: string) => /(kick|snare|hat|clap|perc|drum|tom|cymbal|crash|ride|break|bd|sd|hh)/i.test(path);
