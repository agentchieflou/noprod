// A sound recipe: an arrangement of frequencies that changes over time.
//
// Every sound is a sum of layers. A layer is a set of frequencies (sine
// partials, a band-limited harmonic series, an FM pair, or a band of noise)
// shaped by envelopes and a filter. Frequencies are written relative to the
// sound's root note, so pitched sounds follow the note played.
//
// Times are in seconds. Decays are T60s: the time to fall by 60 dB.

export type Category =
  | 'drums' | 'percussion' | 'bass' | 'keys' | 'mallets' | 'plucks'
  | 'leads' | 'pads' | 'strings' | 'brass' | 'winds' | 'fx';

export interface SoundRecipe {
  id: string;
  name: string;
  category: Category;
  tags?: string[];
  // Pitched sounds follow the note played; unpitched ones (drums, most FX)
  // sound as written whatever the note, and only `transpose` retunes them
  pitched: boolean;
  root?: number;      // MIDI note the recipe is written at (default 60)
  length: number;     // seconds: a one-shot's full length, or how long a pitched note holds without a gate
  gain?: number;      // dB trim after loudness normalization
  seed?: number;      // varies the noise; the same seed always renders the same samples
  layers: Layer[];
}

export type Layer = PartialsLayer | WaveLayer | FmLayer | NoiseLayer | ModelLayer;

// Applies to every kind of layer
export interface LayerBase {
  mute?: boolean;      // left out of the sound (while designing)
  bypass?: string[];   // blocks switched off, settings kept (see chain.ts for the ids)
  level?: number;      // linear gain (default 1)
  pan?: number;        // -1 left .. 1 right
  start?: number;      // seconds after the note starts
  ratio?: number;      // the layer's frequency as a multiple of the root note's (default 1)
  hz?: number;         // or in Hz, at the root note (wins over ratio)
  env?: Envelope;      // amplitude; default: on while the note is held
  pitch?: PitchEnvelope;
  vibrato?: Vibrato;
  tremolo?: Tremolo;
  filter?: Filter | Filter[]; // in series
  drive?: number;      // tanh saturation after the envelope, 0 = clean
  velocity?: number;   // how much velocity changes the level, 0..1 (default 1)
}

// Attack ramps linearly to full level, hold stays there, decay falls toward
// sustain, and release falls from wherever the note-off finds it
export interface Envelope {
  attack?: number;   // default 0.002
  hold?: number;     // default 0
  decay?: number;    // T60 toward sustain (default 0: straight to sustain)
  sustain?: number;  // 0..1 (default 1)
  release?: number;  // T60 after the note-off (default 0.05)
}

// Starts `amount` semitones off and glides back to the layer's pitch
export interface PitchEnvelope {
  amount: number;  // semitones at the start
  time: number;    // T60 of the glide
}

export interface Vibrato {
  rate: number;    // Hz
  depth: number;   // cents
  delay?: number;  // before it starts
  fade?: number;   // time to reach full depth
}

// The level wobbling: a vibraphone's motor, a Leslie, a tremolo pedal
export interface Tremolo {
  rate: number;    // Hz
  depth: number;   // 0..1: how far the level dips
  delay?: number;
}

export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'notch';

export interface Filter {
  type: FilterType;
  cutoff: number;      // Hz at the root note
  q?: number;          // resonance (default 0.707)
  slope?: 12 | 24;     // dB per octave (default 12)
  keyTrack?: number;   // 0: fixed in Hz, 1: follows the note fully (default 0)
  velocity?: number;   // octaves added at full velocity
  env?: Envelope & { amount: number }; // octaves at the envelope's peak
}

// ------------------------------------------------------------------ layers

// Sine partials: the most literal arrangement of frequencies. Give them one
// by one, or as a harmonic series.
export interface PartialsLayer extends LayerBase {
  type: 'partials';
  partials?: Partial[];
  series?: HarmonicSeries;
  stretch?: number;       // inharmonicity B: partial n sounds at n·√(1 + B·n²)
  partialDecay?: number;  // T60 of a partial at ratio 1 (none by default)
  damping?: number;       // higher partials die faster: T60 / ratio^damping
  phases?: 'sine' | 'random';
}

export interface Partial {
  ratio: number;     // of the layer's frequency
  level: number;     // linear
  decay?: number;    // T60 of this partial alone (overrides partialDecay)
  attack?: number;   // its own fade-in
  detune?: number;   // cents
  pan?: number;
}

export interface HarmonicSeries {
  count: number;     // how many harmonics (those past Nyquist are dropped)
  slope?: number;    // dB per octave (default -6, a saw's)
  odd?: number;      // level of the odd harmonics (default 1)
  even?: number;     // level of the even harmonics (default 1)
}

// A classic waveform, built as its harmonic series and band-limited to the
// note so nothing folds back from above Nyquist
export type WaveShape = 'sine' | 'triangle' | 'square' | 'saw' | 'pulse';

export interface WaveLayer extends LayerBase {
  type: 'wave';
  shape?: WaveShape;
  width?: number;         // pulse width 0..1 (default 0.25)
  harmonics?: number[];   // or a custom series: the level of each harmonic, fundamental first
  ratios?: number[];      // several oscillators at these multiples of the layer's frequency (default [1])
  unison?: Unison;
}

export interface Unison {
  voices: number;
  detune: number;   // cents between the outermost voices
  spread?: number;  // stereo width 0..1
}

// One frequency modulating another: sidebands at carrier ± k·modulator
export interface FmLayer extends LayerBase {
  type: 'fm';
  modRatio: number;     // modulator frequency as a multiple of the carrier's
  index: number;        // modulation depth (radians)
  indexEnv?: Envelope;  // scales the index over time
  feedback?: number;    // the modulator modulating itself, 0..1
}

// A band of every frequency at once, with random phases. Shape it with a filter.
export interface NoiseLayer extends LayerBase {
  type: 'noise';
  color?: 'white' | 'pink' | 'brown';
  stereo?: boolean;  // different noise in each channel, for width
}

// ------------------------------------------------------------ physical models

// A physical model: something set vibrating (Stage 1, the exciter) in a
// resonator that rings at the note (Stage 2: a string or an air column, as a
// delay loop), heard through radiators (Stage 3: a body, a bell). Closed-loop
// exciters (bow, lips, jet, reed) read the wave coming back from the
// resonator and keep it going for as long as the player does: the layer's
// envelope is the player's input (bow velocity, breath pressure). Plucks and
// strikes set it going once; the envelope then damps it on release.
export interface ModelLayer extends LayerBase {
  type: 'model';
  exciter: Exciter;
  resonator: Resonator;
  radiators?: Radiator[];  // in series
}

export type Exciter = PluckExciter | StrikeExciter | BowExciter | LipsExciter | JetExciter | ReedExciter;

export interface PluckExciter {
  kind: 'pluck';
  position?: number;  // where along the string, 0..0.5 from the bridge (default 0.2)
  hardness?: number;  // 0 soft (flesh) .. 1 hard (pick) (default 0.6)
}

export interface StrikeExciter {
  kind: 'strike';
  position?: number;  // default 0.12
  hardness?: number;  // a soft felt hammer .. a hard mallet (default 0.5)
}

export interface BowExciter {
  kind: 'bow';
  pressure?: number;  // 0..1: light and airy .. pressed and gritty (default 0.5)
  position?: number;  // 0.03..0.5 from the bridge: sul ponticello .. sul tasto (default 0.13)
  noise?: number;     // bow hair noise 0..1 (default 0.1)
}

export interface LipsExciter {
  kind: 'lips';
  tension?: number;   // the lips' own resonance, as a multiple of the note (default 1)
}

export interface JetExciter {
  kind: 'jet';
  ratio?: number;     // the jet's travel time as a share of the bore's (default 0.32)
  noise?: number;     // breath noise 0..1 (default 0.15)
}

export interface ReedExciter {
  kind: 'reed';
  stiffness?: number; // 0..1 (default 0.5)
  noise?: number;     // default 0.05
}

export type Resonator = StringResonator | BoreResonator;

export interface StringResonator {
  kind: 'string';
  decay?: number;      // T60 of the fundamental, seconds (default 3)
  brightness?: number; // how slowly the upper harmonics die, 0..1 (default 0.5)
  stiffness?: number;  // inharmonicity 0..1, a piano-like stretch (default 0)
}

export interface BoreResonator {
  kind: 'bore';
  // open: a pipe open at the far end; stopped: closed there; flared: a
  // bell and mouthpiece, whose resonances line up as a harmonic series
  end?: 'open' | 'stopped' | 'flared';
  loss?: number;       // 0..1 how quickly it stops ringing, and how dark (default 0.5)
}

export type Radiator = BodyRadiator | HelmholtzRadiator | BellRadiator | ToneholeRadiator | DampingRadiator;

// A wooden body: a bank of resonances (its modes) beside the direct sound
export interface BodyRadiator {
  kind: 'body';
  preset?: 'violin' | 'cello' | 'guitar' | 'harp' | 'box';
  modes?: { hz: number; q: number; gain: number }[];  // instead of a preset
  mix?: number;  // 0 direct .. 1 all body (default 0.7)
}

// The air in a body's cavity: one low resonance
export interface HelmholtzRadiator {
  kind: 'helmholtz';
  hz?: number;   // default 110
  q?: number;    // default 6
  mix?: number;  // default 0.4
}

// A bell radiates the highs and keeps the lows in
export interface BellRadiator {
  kind: 'bell';
  cutoff?: number;  // Hz (default 700)
  mix?: number;     // default 0.8
}

// Open toneholes and the pipe's end: a high-pass a little below the note, and some darkening
export interface ToneholeRadiator {
  kind: 'tonehole';
  cutoff?: number;     // as a multiple of the note (default 0.7)
  brightness?: number; // 0..1 (default 0.6)
}

// A one-pole low-pass, H(z) = (1 − a) / (1 − a·z⁻¹)
export interface DampingRadiator {
  kind: 'damping';
  a?: number;  // 0..0.99 (default 0.5)
}

export interface RenderOptions {
  note?: number;        // MIDI note (default: the recipe's root)
  velocity?: number;    // 0..1 (default 1)
  gate?: number;        // seconds until the note-off; pitched sounds only (default: the recipe's length)
  transpose?: number;   // semitones, for unpitched sounds too
  sampleRate?: number;  // default 44100
  normalize?: boolean;  // apply the recipe's loudness normalization (default true)
}

export interface RenderedSound {
  sampleRate: number;
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
}
