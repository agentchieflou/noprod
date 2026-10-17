// Live physical models (#106) on the engine worklet: a voice a note, each a
// LiveNote from @noprod/sound, from its note-on until it has rung out.
// Note-ons and lets-go arrive with the frame they happen at. A voice is
// made when its note-on arrives (between blocks); rendering a block
// allocates nothing. One of these per strip, as the live-models worklet
// was one node per strip.

import { LiveNote, legato, type LiveTarget, type SoundRecipe } from '@noprod/sound';
import { BLOCK, type VoiceSpec } from './events.ts';

const MAX_VOICES = 16;

interface ModelVoice {
  live: LiveNote;
  sound: string;       // its recipe's id
  legato: boolean;
  held: { key: string; note: number }[];  // the keys down on it: the last sounds (several when slurred)
  released: boolean;
}

interface Pending { at: number; run: () => void }

export class LiveVoices {
  private voices: ModelVoice[] = [];
  private byKey = new Map<string, ModelVoice>();
  private pending: Pending[] = [];
  // where the player's controls are: every voice follows them, new ones from the start
  private controls: { to: LiveTarget; value: number }[] = [];

  private sampleRate: number;

  constructor(sampleRate: number) { this.sampleRate = sampleRate; }

  get sounding() { return this.voices.length; }

  on(key: string, m: Extract<VoiceSpec, { kind: 'model' }>, at: number, now: number) {
    // made now, between blocks (a slur may not need it); it starts sounding at its frame
    const live = new LiveNote(m.recipe, { note: m.note, velocity: m.velocity, sampleRate: this.sampleRate, transpose: m.transpose, gain: m.gain, tunings: m.tunings });
    const slurs = legato(m.recipe);
    this.schedule(at, now, () => {
      // a legato sound slurs to the note when a key of it is still held
      const slurring = slurs ? this.voices.find((v) => v.legato && v.sound === m.recipe.id && !v.released) : undefined;
      if (slurring) {
        slurring.held.push({ key, note: m.note });
        slurring.live.slur(m.note);
        this.byKey.set(key, slurring);
        return;
      }
      for (const c of this.controls) live.control(c.to, c.value, 0);
      const voice: ModelVoice = { live, sound: m.recipe.id, legato: slurs, held: [{ key, note: m.note }], released: false };
      this.steal();
      this.voices.push(voice);
      this.byKey.set(key, voice);
    });
  }

  // Let go: a slurred voice goes back to the key still held under it
  off(key: string, at: number, now: number) {
    this.schedule(at, now, () => {
      const voice = this.byKey.get(key);
      this.byKey.delete(key);
      if (!voice) return;
      const was = voice.held.findIndex((h) => h.key === key);
      if (was >= 0) voice.held.splice(was, 1);
      if (voice.held.length) {
        if (was === voice.held.length) voice.live.slur(voice.held[voice.held.length - 1].note);
        return;
      }
      voice.released = true;
      voice.live.release();
    });
  }

  has(key: string) { return this.byKey.has(key); }

  control(to: LiveTarget, value: number, smoothing: number, at: number, now: number) {
    this.schedule(at, now, () => {
      const was = this.controls.findIndex((c) => c.to === to);
      if (was >= 0) this.controls[was].value = value; else this.controls.push({ to, value });
      for (const v of this.voices) v.live.control(to, value, smoothing);
    });
  }

  stop() {
    this.voices = [];
    this.byKey.clear();
    this.pending = [];
  }

  private schedule(at: number, now: number, run: () => void) {
    if (at <= now) run();
    else this.pending.push({ at, run });
  }

  // At most MAX_VOICES: the oldest let-go voice gives way, else the oldest
  private steal() {
    if (this.voices.length < MAX_VOICES) return;
    let k = this.voices.findIndex((v) => v.released);
    if (k < 0) k = 0;
    const [gone] = this.voices.splice(k, 1);
    for (const h of gone.held) this.byKey.delete(h.key);
  }

  // The whole block starting at `frame` (models start on block boundaries, as before)
  render(l: Float32Array, r: Float32Array, frame: number) {
    if (this.pending.length) {
      const due = frame + BLOCK;
      let kept = 0;
      for (let k = 0; k < this.pending.length; k++) {
        const p = this.pending[k];
        if (p.at < due) p.run(); else this.pending[kept++] = p;
      }
      this.pending.length = kept;
    }
    let kept = 0;
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      v.live.process(l, r, 0, l.length);
      if (!v.live.done) this.voices[kept++] = v;
    }
    this.voices.length = kept;
  }
}

// The audio thread compiles a voice's code as it first plays it, and the
// first note's blocks would take too long to make. A few silent notes,
// played as the module loads (before anything sounds), get it compiled.
export function warmUpLiveModels(sampleRate: number) {
  const recipe = (layer: SoundRecipe['layers'][number]): SoundRecipe => ({ id: 'warm-up', name: '', category: 'strings', pitched: true, root: 60, length: 1, layers: [layer] });
  const env = { attack: 0.02, sustain: 1, release: 0.05 };
  const sounds = [
    recipe({ type: 'model', exciter: { kind: 'bow' }, resonator: { kind: 'string', decay: 1 }, radiators: [{ kind: 'body', preset: 'violin' }], vibrato: { rate: 5, depth: 10 }, env }),
    recipe({ type: 'model', exciter: { kind: 'lips' }, resonator: { kind: 'bore', end: 'flared' }, radiators: [{ kind: 'bell' }], env }),
    recipe({ type: 'model', exciter: { kind: 'jet' }, resonator: { kind: 'bore', end: 'open' }, radiators: [{ kind: 'tonehole' }], env }),
    recipe({ type: 'model', exciter: { kind: 'reed' }, resonator: { kind: 'bore', end: 'open' }, radiators: [{ kind: 'tonehole' }, { kind: 'damping' }], env }),
    recipe({ type: 'model', exciter: { kind: 'pluck' }, resonator: { kind: 'string', decay: 2, stiffness: 0.1, buzz: 0.3 }, strings: [{ kind: 'unison', cents: [1] }, { kind: 'sympathetic', cents: [700] }],
      radiators: [{ kind: 'body' }, { kind: 'helmholtz' }], parallel: [{ kind: 'bell' }], env: { sustain: 1, release: 0.2 } })
  ];
  const left = new Float32Array(BLOCK), right = new Float32Array(BLOCK);
  for (const sound of sounds) {
    const live = new LiveNote(sound, { note: 60, velocity: 0.8, sampleRate, tunings: [1] });
    for (let k = 0; k < 120; k++) {
      if (k === 100) live.release();
      live.process(left, right, 0, BLOCK);
    }
  }
}
