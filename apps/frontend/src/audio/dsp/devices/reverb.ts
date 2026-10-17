// NoProd Reverb: an 8-line feedback delay network in place of the
// convolution with Math.random noise the native graph used, so a render
// is the same twice. Mono in (the channels summed), two diffusing
// allpasses, eight delay lines of prime lengths between 27 and 66 ms fed
// back through a Hadamard matrix (lossless, so the decay is set by one
// gain per line: -60 dB over Decay seconds, Jot's rule g = 10^(-3 L / (T
// sr))), a one-pole damping per line so highs decay faster as in a room,
// and each line's read point swayed by its own slow sine (seeded phases
// and rates) against the metallic ring of fixed lengths. Left and right
// take the lines with two orthogonal sign patterns, so they decorrelate.

import { createRandom } from '@noprod/sound';
import { BLOCK, FLUSH, Mix, num, type DeviceKernel, type ParamValue } from './kernel.ts';

const LINES = 8;
const LENGTHS_MS = [27.5, 34.5, 39.1, 42.8, 48.1, 52.9, 59.4, 65.9];
const DIFFUSE_MS = [4.4, 7.2];
const DIFFUSE_G = 0.6;
const DAMPING = 0.1;            // the one-pole's coefficient: 0 is none; the top octave decays about twice as fast
const SWAY_MS = 0.12;           // the read point moves this far either way
// Left takes the lines as + - + - + - + -, right as + + - - + + - -
const SEED = 0x7e4e2b;
// So a steady input comes out about as loud wet as dry at the default
// Decay, as the convolver's normalization kept it
const LEVEL = 0.22;
const MAX_DECAY = 10, MIN_DECAY = 0.2;

export class Reverb implements DeviceKernel {
  readonly kind = 'reverb';
  readonly latency = 0;
  private readonly sampleRate: number;
  private readonly lines: Float32Array[] = [];
  private readonly lengths: number[] = [];      // frames, the nominal delay of each line
  private readonly size: number;                // every line's buffer
  private write = 0;
  private readonly gains = new Float64Array(LINES);
  private readonly damp = new Float64Array(LINES);   // the one-pole's state per line
  // each line's sway: a sine and cosine pair stepped by epsilon a frame
  private readonly swayA = new Float64Array(LINES);
  private readonly swayB = new Float64Array(LINES);
  private readonly swayStart = new Float64Array(LINES * 2);  // for reset
  private readonly swayEps = new Float64Array(LINES);
  private readonly swayFrames: number;
  private readonly diffuse: Float32Array[] = [];
  private readonly diffuseLen: number[] = [];
  private readonly diffuseAt = [0, 0];
  private decay = 2.5;
  private readonly mix: Mix;
  private quiet = 0;            // frames of silence at the input
  private clean = true;         // the network holds nothing
  private primed = false;
  private readonly w = new Float32Array(BLOCK);
  private readonly s = new Float64Array(LINES);       // the lines' outputs this sample
  private readonly ap = new Float64Array(LINES);      // each line's interpolating allpass state

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const random = createRandom(SEED);
    this.swayFrames = SWAY_MS * 1e-3 * sampleRate;
    let longest = 0;
    for (let i = 0; i < LINES; i++) {
      const n = Math.round(LENGTHS_MS[i] * 1e-3 * sampleRate);
      this.lengths.push(n);
      longest = Math.max(longest, n);
      const phase = random() * 2 * Math.PI;
      this.swayA[i] = this.swayStart[i] = Math.sin(phase);
      this.swayB[i] = this.swayStart[LINES + i] = Math.cos(phase);
      this.swayEps[i] = (2 * Math.PI * (0.15 + 0.5 * random())) / sampleRate;
    }
    this.size = longest + Math.ceil(this.swayFrames) + BLOCK + 4;
    for (let i = 0; i < LINES; i++) this.lines.push(new Float32Array(this.size));
    for (let i = 0; i < 2; i++) {
      const n = Math.round(DIFFUSE_MS[i] * 1e-3 * sampleRate);
      this.diffuseLen.push(n);
      this.diffuse.push(new Float32Array(n));
    }
    this.mix = new Mix(30, sampleRate);
    this.setDecay(2.5);
  }

  private setDecay(seconds: number) {
    this.decay = Math.max(MIN_DECAY, Math.min(MAX_DECAY, seconds));
    for (let i = 0; i < LINES; i++) this.gains[i] = Math.pow(10, (-3 * this.lengths[i]) / (this.decay * this.sampleRate));
  }

  // To -90 dB: the strip keeps it alive that long after its sources end
  tail() { return Math.ceil(1.5 * this.decay * this.sampleRate); }

  set(name: string, value: ParamValue) {
    if (name === 'Decay') this.setDecay(num(value, this.decay));
    else if (name === 'Dry/Wet') { this.mix.set(num(value, 30)); if (!this.primed) this.mix.wet.snap(); }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const { lines, lengths, size, gains, damp, diffuse, diffuseLen, diffuseAt, w, s, ap, swayA, swayB, swayEps, swayFrames } = this;
    const mixVaries = this.mix.fill(w, frames, ramps?.get('Dry/Wet'));
    // Silence in: once the tail has passed, the network is empty for real
    // (what is left is below -90 dB and would decay into the subnormals)
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const l = inL[i], r = inR[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
    }
    if (peak > FLUSH) { this.quiet = 0; this.clean = false; } else this.quiet += frames;
    if (!this.clean && this.quiet > this.tail()) this.empty();
    if (this.clean) {
      // nothing to add: the dry signal through the mix
      let wet = w[0];
      for (let i = 0; i < frames; i++) {
        if (mixVaries) wet = w[i];
        outL[i] = inL[i] - inL[i] * wet;
        outR[i] = inR[i] - inR[i] * wet;
      }
      return;
    }
    const l0 = lines[0], l1 = lines[1], l2 = lines[2], l3 = lines[3], l4 = lines[4], l5 = lines[5], l6 = lines[6], l7 = lines[7];
    const d0 = diffuse[0], d1 = diffuse[1], n0 = diffuseLen[0], n1 = diffuseLen[1];
    let a0 = diffuseAt[0], a1 = diffuseAt[1];
    let write = this.write;
    const norm = 1 / Math.sqrt(LINES);
    let wet = w[0];
    for (let i = 0; i < frames; i++) {
      if (mixVaries) wet = w[i];
      const xl = inL[i], xr = inR[i];
      // in: the channels summed, through two allpasses
      let x = (xl + xr) * 0.5;
      let v = d0[a0]; let u = x - DIFFUSE_G * v; d0[a0] = u; x = v + DIFFUSE_G * u; if (++a0 === n0) a0 = 0;
      v = d1[a1]; u = x - DIFFUSE_G * v; d1[a1] = u; x = v + DIFFUSE_G * u; if (++a1 === n1) a1 = 0;
      // each line's output at its swayed read point, damped and scaled for the decay
      for (let k = 0; k < LINES; k++) {
        const eps = swayEps[k];
        const sa = swayA[k] + eps * swayB[k];
        swayA[k] = sa;
        swayB[k] -= eps * sa;
        // Read between two samples with a first-order allpass, which loses
        // nothing at any frequency (linear interpolation would damp the
        // highs by itself); the fraction is kept in 0.5..1.5 so the
        // allpass's coefficient stays small
        const d = lengths[k] + sa * swayFrames;
        const whole = Math.floor(d - 0.5), frac = d - whole;
        let a = write - whole; if (a < 0) a += size;
        let b = a - 1; if (b < 0) b += size;
        const line = lines[k];
        const eta = (1 - frac) / (1 + frac);
        const y = eta * (line[a] - ap[k]) + line[b];
        ap[k] = y;
        const z = y + (damp[k] - y) * DAMPING;
        damp[k] = z;
        s[k] = z * gains[k];
      }
      const s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3], s4 = s[4], s5 = s[5], s6 = s[6], s7 = s[7];
      // out: two orthogonal sign patterns over the lines
      outL[i] = xl + ((s0 - s1 + s2 - s3 + s4 - s5 + s6 - s7) * LEVEL - xl) * wet;
      outR[i] = xr + ((s0 + s1 - s2 - s3 + s4 + s5 - s6 - s7) * LEVEL - xr) * wet;
      // feedback: the Hadamard butterfly, scaled to be lossless
      const b0 = s0 + s1, b1 = s0 - s1, b2 = s2 + s3, b3 = s2 - s3, b4 = s4 + s5, b5 = s4 - s5, b6 = s6 + s7, b7 = s6 - s7;
      const c0 = b0 + b2, c1 = b1 + b3, c2 = b0 - b2, c3 = b1 - b3, c4 = b4 + b6, c5 = b5 + b7, c6 = b4 - b6, c7 = b5 - b7;
      l0[write] = x + (c0 + c4) * norm; l1[write] = -x + (c1 + c5) * norm; l2[write] = x + (c2 + c6) * norm; l3[write] = -x + (c3 + c7) * norm;
      l4[write] = x + (c0 - c4) * norm; l5[write] = -x + (c1 - c5) * norm; l6[write] = x + (c2 - c6) * norm; l7[write] = -x + (c3 - c7) * norm;
      if (++write === size) write = 0;
    }
    this.write = write; diffuseAt[0] = a0; diffuseAt[1] = a1;
    for (let k = 0; k < LINES; k++) {
      const z = damp[k]; damp[k] = z > FLUSH || z < -FLUSH ? z : 0;
      const y = ap[k]; ap[k] = y > FLUSH || y < -FLUSH ? y : 0;
    }
  }

  private empty() {
    for (let k = 0; k < LINES; k++) { this.lines[k].fill(0); this.damp[k] = 0; this.ap[k] = 0; }
    this.diffuse[0].fill(0); this.diffuse[1].fill(0);
    this.clean = true;
  }

  reset() {
    this.empty();
    this.quiet = 0;
    this.write = 0; this.diffuseAt[0] = 0; this.diffuseAt[1] = 0;
    for (let k = 0; k < LINES; k++) { this.swayA[k] = this.swayStart[k]; this.swayB[k] = this.swayStart[LINES + k]; }
    this.mix.wet.snap();
  }
}
