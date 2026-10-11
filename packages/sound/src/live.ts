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

export class LiveNote {
  readonly note: number;
  private readonly layers: { voice: ModelLayerVoice; offset: number; done: boolean }[];
  private readonly gain: number;
  private readonly glide: number;
  private sounding: number;   // the note the voice is playing (slurs move it)
  private semitones = 0;      // where the voice is, from its first note: a slur on its way, and the bend
  private bend = 0;           // the player's bend, in semitones
  private i = 0;
  expression = 1;             // the player's swell: scales the bow or breath (0..1)
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

  // The player's bend, in semitones
  bendTo(semitones: number) {
    this.bend = semitones;
  }

  // Adds samples [from, to) of the note into `left` and `right`
  process(left: Float32Array, right: Float32Array, from: number, to: number) {
    const target = this.sounding - this.note;
    for (let k = from; k < to && !this.done; k++) {
      this.semitones = target + (this.semitones - target) * this.glide;
      const bend = this.semitones === 0 && this.bend === 0 ? 1 : Math.pow(2, (this.semitones + this.bend) / 12);
      let l = 0, r = 0, alive = false;
      for (let n = 0; n < this.layers.length; n++) {
        const layer = this.layers[n];
        if (layer.done) continue;
        alive = true;
        if (this.i < layer.offset) continue;
        if (!layer.voice.next(bend, this.expression)) { layer.done = true; continue; }
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
