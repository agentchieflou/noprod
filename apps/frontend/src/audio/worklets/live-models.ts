// Live physical models (#106), on the audio thread: a voice a note, each a
// LiveNote from @noprod/sound, from its note-on until it has rung out.
// Note-ons and lets-go arrive as messages, each with the audio time it
// happens at. A voice is made when its note-on arrives (between blocks);
// rendering a block allocates nothing.

import { LiveNote, legato, type LiveTarget, type SoundRecipe } from '@noprod/sound';

// The AudioWorkletGlobalScope's (not in the DOM types)
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; }

const MAX_VOICES = 16;
const BLOCK = 128;

export type LiveModelsMessage =
  | { type: 'on'; id: number; recipe: SoundRecipe; note: number; velocity: number; transpose: number; gain: number; tunings: number[]; at: number }
  | { type: 'off'; id: number; at: number }
  | { type: 'control'; to: LiveTarget; value: number; smoothing: number; at: number }
  | { type: 'stop' }
  | { type: 'stats' };

interface Voice {
  live: LiveNote;
  sound: string;       // its recipe's id
  legato: boolean;
  held: { id: number; note: number }[];  // the keys down on it: the last sounds (several when slurred)
  start: number;       // audio time it starts
  released: boolean;
}

interface Pending { at: number; run: () => void }

class LiveModels extends AudioWorkletProcessor {
  private voices: Voice[] = [];
  private byId = new Map<number, Voice>();
  private pending: Pending[] = [];
  // where the player's controls are: every voice follows them, new ones from the start
  private controls: { to: LiveTarget; value: number }[] = [];
  // How it's coping, as this processor can see it (to the millisecond). A
  // block that takes longer to make than it lasts is late; the audio
  // device has some audio queued (`margin`, its output latency), so the
  // thread can fall behind by that much and catch up. A dropout is falling
  // further behind than that: the device ran out.
  private blocks = 0;
  private late = 0;
  private dropouts = 0;
  private behind = 0;   // milliseconds behind real time
  private busy = 0;     // milliseconds spent making blocks
  private worst = 0;
  private readonly margin: number;

  constructor(options: { processorOptions?: { margin?: number } }) {
    super();
    this.margin = options.processorOptions?.margin ?? 10;
    this.port.onmessage = (e: MessageEvent<LiveModelsMessage>) => this.receive(e.data);
  }

  private receive(m: LiveModelsMessage) {
    if (m.type === 'stats') {
      this.port.postMessage({ type: 'stats', voices: this.voices.length, blocks: this.blocks, late: this.late, dropouts: this.dropouts, busy: this.busy, worst: this.worst, seconds: this.blocks * BLOCK / sampleRate });
      return;
    }
    if (m.type === 'stop') {
      this.voices = [];
      this.byId.clear();
      this.pending = [];
      return;
    }
    if (m.type === 'control') {
      this.schedule(m.at, () => {
        const was = this.controls.findIndex((c) => c.to === m.to);
        if (was >= 0) this.controls[was].value = m.value; else this.controls.push({ to: m.to, value: m.value });
        for (const v of this.voices) v.live.control(m.to, m.value, m.smoothing);
      });
      return;
    }
    if (m.type === 'on') {
      // made now, between blocks (a slur may not need it); it starts sounding at its time
      const live = new LiveNote(m.recipe, { note: m.note, velocity: m.velocity, sampleRate, transpose: m.transpose, gain: m.gain, tunings: m.tunings });
      const slurs = legato(m.recipe);
      this.schedule(m.at, () => {
        // a legato sound slurs to the note when a key of it is still held
        const slurring = slurs ? this.voices.find((v) => v.legato && v.sound === m.recipe.id && !v.released) : undefined;
        if (slurring) {
          slurring.held.push({ id: m.id, note: m.note });
          slurring.live.slur(m.note);
          this.byId.set(m.id, slurring);
          return;
        }
        for (const c of this.controls) live.control(c.to, c.value, 0);
        const voice: Voice = { live, sound: m.recipe.id, legato: slurs, held: [{ id: m.id, note: m.note }], start: m.at, released: false };
        this.steal();
        this.voices.push(voice);
        this.byId.set(m.id, voice);
      });
      return;
    }
    // let go: a slurred voice goes back to the key still held under it
    this.schedule(m.at, () => {
      const voice = this.byId.get(m.id);
      this.byId.delete(m.id);
      if (!voice) return;
      const was = voice.held.findIndex((h) => h.id === m.id);
      if (was >= 0) voice.held.splice(was, 1);
      if (voice.held.length) {
        if (was === voice.held.length) voice.live.slur(voice.held[voice.held.length - 1].note);
        return;
      }
      voice.released = true;
      voice.live.release();
    });
  }

  private schedule(at: number, run: () => void) {
    if (at <= currentTime) run();
    else this.pending.push({ at, run });
  }

  // At most MAX_VOICES: the oldest let-go voice gives way, else the oldest
  private steal() {
    if (this.voices.length < MAX_VOICES) return;
    let k = this.voices.findIndex((v) => v.released);
    if (k < 0) k = 0;
    const [gone] = this.voices.splice(k, 1);
    for (const h of gone.held) this.byId.delete(h.id);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const began = Date.now();
    const [left, right] = outputs[0];
    left.fill(0);
    right.fill(0);
    // what's due by the end of this block
    if (this.pending.length) {
      const due = currentTime + BLOCK / sampleRate;
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
      v.live.process(left, right, 0, left.length);
      if (!v.live.done) this.voices[kept++] = v;
    }
    this.voices.length = kept;
    const took = Date.now() - began;
    const lasts = (BLOCK / sampleRate) * 1000;
    this.blocks++;
    this.busy += took;
    if (took > this.worst) this.worst = took;
    if (took > lasts) this.late++;
    this.behind = Math.max(0, this.behind + took - lasts);
    if (this.behind > this.margin) {
      this.dropouts++;
      this.behind = 0;
    }
    return true;
  }
}

// The audio thread compiles a voice's code as it first plays it, and the
// first note's blocks would take too long to make. A few silent notes,
// played as the module loads (before anything sounds), get it compiled.
function warmUp() {
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

warmUp();
registerProcessor('noprod-live-models', LiveModels);
