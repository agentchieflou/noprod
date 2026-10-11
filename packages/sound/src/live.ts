// A note of a sound, played live (#106): each of its model layers a sample
// at a time, for as long as the key is held, following the player (a bend,
// a swell of the bow or breath, a slur to the next note); let go, each
// rings out as the instrument does. Released where a rendered note's gate
// is, it plays what `render` makes of that note, to the bit.
//
// Making one allocates (do it outside the audio callback, with the tunings
// measured off the audio thread); playing it doesn't.

import { ModelLayerVoice, noteSeed, type NoteContext } from './render.ts';
import { closedLoop, modelTuning } from './model.ts';
import { midiToHz } from './dsp.ts';
import type { SoundRecipe } from './types.ts';

// A pitched sound whose layers are all physical models plays live
export const playsLive = (recipe: SoundRecipe) =>
  recipe.pitched && recipe.layers.some((l) => !l.mute) && recipe.layers.every((l) => l.mute || l.type === 'model');

// Slurred from note to note (one voice) rather than a voice a note
export const legato = (recipe: SoundRecipe) => recipe.legato ?? recipe.layers.every((l) =>
  l.mute || (l.type === 'model' && (l.exciter.kind === 'lips' || l.exciter.kind === 'jet' || l.exciter.kind === 'reed')));

// What a note is, to its layers
function noteContext(recipe: SoundRecipe, note: number, velocity: number, sampleRate: number, transpose = 0): NoteContext {
  const root = recipe.root ?? 60;
  return {
    sampleRate,
    rootHz: midiToHz(root),
    pitchScale: Math.pow(2, (note - root + transpose) / 12),
    velocity: Math.min(1, Math.max(0, velocity)),
    seed: noteSeed(recipe)
  };
}

// The tunings a live note's closed loops need (see `modelTuning`): measure
// them off the audio thread, and pass them in
export function liveTunings(recipe: SoundRecipe, note: number, velocity: number, sampleRate: number, transpose = 0): number[] {
  const ctx = noteContext(recipe, note, velocity, sampleRate, transpose);
  return recipe.layers.map((layer, index) => {
    if (layer.type !== 'model' || !closedLoop(layer.exciter)) return 1;
    const off = new Set(layer.bypass ?? []);
    if (off.has('resonator') || off.has('exciter')) return 1;
    const baseHz = (layer.hz ?? ctx.rootHz * (layer.ratio ?? 1)) * ctx.pitchScale;
    return modelTuning(layer, { sampleRate, baseHz, velocity: ctx.velocity, seed: ctx.seed + index * 7919, off });
  });
}

export interface LiveNoteOptions {
  note: number;
  velocity: number;     // 0..1
  sampleRate: number;
  transpose?: number;   // semitones
  gain?: number;        // the sound's level: `loudnessGain` × its trim (default 1: as rendered unnormalized)
  tunings?: number[];   // each layer's tuning, from `modelTuning` (closed loops; 1 where missing)
  bendRange?: number;   // how far below its note it may bend or slur, in semitones (default 14)
}

const SLUR = 0.03;  // seconds a slur takes to reach the new note

// ----------------------------------------------------------- controls

// What a player's controls move in a live note (#106), as data, so the DSP
// Map and the Sound Designer can show it. `to`: the player's input to a bow
// or breath (0..1, as the envelope is), vibrato added (cents, full scale
// `range`), or a bend (semitones, full scale `range`, either way). Each is
// followed smoothly, reaching a move in `smoothing` seconds.
export type LiveTarget = 'input' | 'vibrato' | 'bend';

export interface LiveControl {
  label: string;
  from: { type: 'cc'; controller: number } | { type: 'pressure' } | { type: 'bend' };
  to: LiveTarget;
  range: number;
  smoothing: number;
}

export const LIVE_CONTROLS: LiveControl[] = [
  { label: 'Breath', from: { type: 'cc', controller: 2 }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Expression', from: { type: 'cc', controller: 11 }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Aftertouch', from: { type: 'pressure' }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Mod wheel', from: { type: 'cc', controller: 1 }, to: 'vibrato', range: 40, smoothing: 0.15 },
  { label: 'Pitch bend', from: { type: 'bend' }, to: 'bend', range: 2, smoothing: 0.01 }
];

const VIBRATO_RATE = 5.5;  // Hz, of the vibrato a mod wheel adds

// What a MIDI control event moves, and to what (`value`: 0..1, a bend -1..1)
export function liveControl(event: { type: string; controller?: number; value?: number }): { to: LiveTarget; value: number; smoothing: number } | null {
  const control = LIVE_CONTROLS.find((c) => c.from.type === event.type && (c.from.type !== 'cc' || c.from.controller === event.controller));
  if (!control || event.value === undefined) return null;
  return { to: control.to, value: event.value * control.range, smoothing: control.smoothing };
}

export class LiveNote {
  readonly note: number;
  private readonly layers: { voice: ModelLayerVoice; offset: number; done: boolean }[];
  private readonly gain: number;
  private readonly glide: number;
  private sounding: number;   // the note the voice is playing (slurs move it)
  private semitones = 0;      // where the voice is from its first note: a slur on its way
  private readonly sr: number;
  // The controls, where they're going and where they are, each followed by a one-pole
  private readonly target = { input: 1, vibrato: 0, bend: 0 };
  private readonly follow = { input: 0, vibrato: 0, bend: 0 };
  private input = 1;
  private vibrato = 0;
  private bend = 0;
  private phase = 0;          // of the added vibrato
  private i = 0;
  done = false;

  constructor(recipe: SoundRecipe, options: LiveNoteOptions) {
    const sr = options.sampleRate;
    this.note = this.sounding = options.note;
    const note = noteContext(recipe, options.note, options.velocity, sr, options.transpose);
    const lowestBend = Math.pow(2, -(options.bendRange ?? 14) / 12);
    this.layers = recipe.layers.flatMap((layer, index) => (layer.mute || layer.type !== 'model' || layer.bypass?.includes('source') ? [] : [{
      voice: new ModelLayerVoice(layer, index, note, { tune: options.tunings?.[index] ?? 1, lowestBend }),
      offset: Math.round((layer.start ?? 0) * sr),
      done: false
    }]));
    this.gain = options.gain ?? 1;
    this.sr = sr;
    this.glide = Math.exp(-1 / (SLUR * sr / 4.6));
    if (!this.layers.length) this.done = true;
  }

  // The key is let go
  release() {
    for (const l of this.layers) l.voice.release();
  }

  // Slurs to another note (legato): the same voice, no new attack
  slur(note: number) {
    this.sounding = note;
  }

  // A control moved (see `LIVE_CONTROLS`): the player's input to the bow or
  // breath (0..1), vibrato (cents) or bend (semitones), reached in `smoothing` seconds
  control(to: LiveTarget, value: number, smoothing = 0.03) {
    this.target[to] = value;
    this.follow[to] = Math.exp(-4.6 / Math.max(1, smoothing * this.sr));
  }

  // Adds samples [from, to) of the note into `left` and `right`
  process(left: Float32Array, right: Float32Array, from: number, to: number) {
    const target = this.sounding - this.note;
    const t = this.target, f = this.follow;
    for (let k = from; k < to && !this.done; k++) {
      this.semitones = target + (this.semitones - target) * this.glide;
      // (left alone, the controls stay exactly where they are, and so does the note)
      this.input = t.input + (this.input - t.input) * f.input;
      this.bend = t.bend + (this.bend - t.bend) * f.bend;
      this.vibrato = t.vibrato + (this.vibrato - t.vibrato) * f.vibrato;
      let cents = 100 * (this.semitones + this.bend);
      if (this.vibrato !== 0) {
        cents += this.vibrato * Math.sin(2 * Math.PI * this.phase);
        this.phase += VIBRATO_RATE / this.sr;
        if (this.phase >= 1) this.phase -= 1;
      }
      const bend = cents === 0 ? 1 : Math.pow(2, cents / 1200);
      let l = 0, r = 0, alive = false;
      for (let n = 0; n < this.layers.length; n++) {
        const layer = this.layers[n];
        if (layer.done) continue;
        alive = true;
        if (this.i < layer.offset) continue;
        if (!layer.voice.next(bend, this.input)) { layer.done = true; continue; }
        // mixed as a rendered note's layers are, in 32-bit floats
        const x = layer.voice.out * layer.voice.level;
        l = Math.fround(l + x * layer.voice.pl);
        r = Math.fround(r + x * layer.voice.pr);
      }
      if (!alive) { this.done = true; break; }
      left[k] += Math.fround(l * this.gain);
      right[k] += Math.fround(r * this.gain);
      this.i++;
    }
  }
}
