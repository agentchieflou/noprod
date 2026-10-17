// An audio clip on the engine worklet: its buffer read at a rate from a
// source offset, wrapped at its loop, from a frame to a frame, with its gain.
// A warped clip whose stretched render isn't ready plays as grains: a grain
// every hop, each a short piece of the source read at the pitch rate and
// windowed, as clipPlayback.ts did with a node per grain.

import { createRandom } from '@noprod/sound';
import type { ClipEvent } from './events.ts';
import type { Buf } from './voices.ts';

const CUT = 0.003;

interface Grain { start: number; pos: number; len: number; rise: number; fall: number; i: number }

export class ClipPlayer {
  done = false;
  private pos: number;               // source frames (fractional)
  private readonly rate: number;
  private readonly gain: number;
  private readonly loopStart: number;  // source frames
  private readonly loopEnd: number;
  private readonly length: number;
  private endAt: number;
  private fadeAt = Infinity;
  private fade = 1;
  private fadeCoef = 0;
  // grains
  private readonly grains: Grain[] = [];
  private readonly grain: ClipEvent['grains'];
  private nextGrain: number;         // frame the next grain starts
  private readonly random: () => number;
  private readonly hop: number;

  readonly key: string;
  readonly start: number;
  private buf: Buf;
  private sampleRate: number;

  constructor(key: string, start: number, spec: ClipEvent, buf: Buf, endFrame: number, sampleRate: number, seed: number) {
    this.key = key;
    this.start = start;
    this.buf = buf;
    this.sampleRate = sampleRate;
    this.pos = spec.offset * sampleRate;
    this.rate = spec.rate;
    this.gain = spec.gain;
    this.loopStart = spec.loop ? spec.loop[0] * sampleRate : 0;
    this.loopEnd = spec.loop ? spec.loop[1] * sampleRate : Infinity;
    this.length = buf.l.length;
    this.endAt = endFrame;
    this.grain = spec.grains;
    this.hop = spec.grains ? Math.max(1, Math.round(spec.grains.hop * sampleRate)) : 0;
    this.nextGrain = start;
    this.random = createRandom(seed);
    this.fadeCoef = Math.exp(-1 / (CUT * sampleRate));
  }

  private wrap(pos: number): number {
    if (pos < this.loopEnd) return pos;
    const len = this.loopEnd - this.loopStart;
    return len > 0 ? this.loopStart + ((pos - this.loopEnd) % len) : pos;
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number, frame: number) {
    if (this.grain) { this.renderGrains(l, r, from, to, frame); return; }
    const { l: bl, r: br } = this.buf;
    const rate = this.rate;
    let pos = this.pos;
    for (let i = from; i < to; i++) {
      const f = frame + i;
      if (f >= this.endAt) { this.done = true; break; }
      let g = this.gain;
      if (f >= this.fadeAt) { this.fade *= this.fadeCoef; g *= this.fade; }
      pos = this.wrap(pos);
      const k = pos | 0;
      if (k + 1 >= this.length) {
        if (k >= this.length || this.loopEnd === Infinity) { this.done = true; break; }
        l[i] += bl[k] * g; r[i] += br[k] * g;
      } else {
        const t = pos - k;
        l[i] += (bl[k] + (bl[k + 1] - bl[k]) * t) * g;
        r[i] += (br[k] + (br[k + 1] - br[k]) * t) * g;
      }
      pos += rate;
    }
    this.pos = pos;
  }

  // Grains: every `hop` a new grain starts at the source position the clip
  // has reached, read at the pitch rate, with a half-hop rise and fall
  private renderGrains(l: Float32Array, r: Float32Array, from: number, to: number, frame: number) {
    const { grain, hop, jitter, pitch } = this.grain!;
    const sr = this.sampleRate;
    const { l: bl, r: br } = this.buf;
    const grainFrames = Math.round(grain * sr);
    const halfHop = Math.round((hop / 2) * sr);
    for (let i = from; i < to; i++) {
      const f = frame + i;
      if (f >= this.endAt) { this.done = true; break; }
      while (f >= this.nextGrain && this.nextGrain < this.endAt) {
        // where the clip is at this grain's start: offset plus what's played, loop-wrapped
        let pos = this.wrap(this.pos + (this.nextGrain - this.start) * this.rate);
        if (jitter) pos = Math.max(0, pos + (this.random() * 2 - 1) * jitter * sr);
        const len = Math.min(grainFrames, this.endAt - this.nextGrain);
        if (pos < this.length - 0.005 * sr) {
          this.grains.push({ start: this.nextGrain, pos, len, rise: Math.min(halfHop, len >> 1), fall: Math.max(len - halfHop, len >> 1), i: 0 });
        }
        this.nextGrain += this.hop;
      }
      let g = this.gain;
      if (f >= this.fadeAt) { this.fade *= this.fadeCoef; g *= this.fade; }
      let w = 0;
      for (let k = 0; k < this.grains.length; k++) {
        const gr = this.grains[k];
        if (f < gr.start) { this.grains[w++] = gr; continue; }
        const n = f - gr.start;
        if (n >= gr.len) continue; // over
        const env = n < gr.rise ? n / Math.max(1, gr.rise) : n >= gr.fall ? (gr.len - n) / Math.max(1, gr.len - gr.fall) : 1;
        const p = gr.pos + n * pitch;
        const q = p | 0;
        if (q + 1 < this.length) {
          const t = p - q;
          const e = env * g;
          l[i] += (bl[q] + (bl[q + 1] - bl[q]) * t) * e;
          r[i] += (br[q] + (br[q + 1] - br[q]) * t) * e;
        }
        this.grains[w++] = gr;
      }
      this.grains.length = w;
    }
  }

  stop(at: number) {
    this.fadeAt = Math.min(this.fadeAt, at);
    this.endAt = Math.min(this.endAt, at + Math.round(CUT * 8 * this.sampleRate));
  }
}
