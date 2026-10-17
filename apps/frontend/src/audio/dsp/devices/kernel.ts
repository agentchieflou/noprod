// What a device is once it runs inside the engine worklet (#159, step 5):
// a kernel takes stereo blocks and its parameters in the ParamSpec's own
// units, and smooths them itself so a knob never clicks. Pure TypeScript:
// no Web Audio and no DOM, so the same code renders live and offline.
//
// The rules every kernel keeps: constructed as `new X(sampleRate)` with
// every parameter at its default; any block length up to 128; nothing
// allocated in process(); no Math.random; nothing shared between instances;
// floats in, floats out, never clipped unless it is the limiter.

export type ParamValue = number | boolean | string; // dB, Hz, ms, %, an enum's label

export const BLOCK = 128;      // the longest block a kernel is handed

export interface DeviceKernel {
  readonly kind: string;
  // Frames of delay the device adds to its signal, fixed for the instance
  // (a lookahead limiter). The strip sums its devices' and delays the
  // others to match.
  readonly latency: number;
  // Frames it may keep sounding after its input falls silent (a reverb's
  // decay, a delay's feedback): the strip keeps processing it that long
  // after its last source ends, then skips it. 0 for an EQ.
  tail(): number;
  // A parameter's value from frame `at` on (k-rate). The kernel smooths it
  // itself; `at` is on or before the next block, so it takes effect there.
  set(name: string, value: ParamValue, at: number): void;
  // One block: `frames` samples of stereo in to stereo out, in place allowed
  // (inL === outL). `ramps` carries this block's a-rate automation: for each
  // named parameter, its value at the block's first and last frame; the
  // kernel interpolates and leaves the parameter at `to` afterwards.
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [from: number, to: number]>): void;
  // Forget the past (a seek, a stop): delay lines and envelopes to silence,
  // parameters kept and no longer gliding. Leaves the device fit to process.
  reset(): void;
  // Optional, for the UI's meters and curves:
  reduction?(): number;                        // gain reduction in dB (<= 0)
  response?(freqs: Float32Array): Float32Array; // magnitude response in dB
}

export const dbToGain = (db: number, floorDb = -60) => (db <= floorDb ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-6, g));

// A ParamValue as a number: '4:1' is 4, '10 ms' is 10, true is 1
export const num = (v: ParamValue | undefined, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

// Filter states and envelopes below this are flushed to exactly zero at the
// end of a block (`x > FLUSH || x < -FLUSH ? x : 0`, written out where it
// is used): JS has no flush-to-zero, and a value decaying through the
// subnormal range (below 1.2e-38 as a float, 2.2e-308 as a double) costs
// many times a normal multiply. -360 dB is far below anything audible, and
// 128 samples of decay can't take a state from here into the subnormals.
export const FLUSH = 1e-18;

// What a kernel's block path avoids, besides `new`: handing a double to, or
// getting one back from, a call the JIT may not inline (a Math function is
// fine; a method of ours or fill() is not), since a double crossing a call
// is boxed, an allocation. So the smoother's steps leave their result in
// `value`, a section computes its coefficients from its fields, and a
// ramp's step `(to - from) / max(1, frames - 1)` and the flush above are
// written out where they are used.

// A parameter that glides to its target with a one-pole (about 5 ms), so a
// knob moves without a step. `snap` is for the first setting and a reset.
//
// A number a kernel writes while processing is declared with a numeric
// initializer, here and in every kernel: a field first seen as undefined
// is tagged, and every double stored in one afterwards is a fresh heap
// number, which is an allocation per sample.
export class Smoothed {
  value = 0;
  target = 0;
  private readonly coef: number;
  constructor(value: number, sampleRate: number, seconds = 0.005) {
    this.value = this.target = value;
    this.coef = Math.exp(-1 / (seconds * sampleRate));
  }
  get moving() { return this.value !== this.target; }
  set(target: number) { this.target = target; }
  snap(value = this.target) { this.value = this.target = value; }
  // One sample on: `value` moves toward the target, and settles on it once
  // within 1e-7 of it, so a kernel can tell when the glide is over
  tick() {
    const t = this.target;
    let v = t + (this.value - t) * this.coef;
    if (Math.abs(v - t) < 1e-7 * Math.max(1, Math.abs(t))) v = t;
    this.value = v;
  }
  // `frames` samples on, in one step (for a parameter used once a block)
  skip(frames: number) {
    const t = this.target;
    if (this.value === t) return;
    let v = t + (this.value - t) * Math.pow(this.coef, frames);
    if (Math.abs(v - t) < 1e-7 * Math.max(1, Math.abs(t))) v = t;
    this.value = v;
  }
}

// The dry/wet crossfade several devices share: wet and dry gains in 0..1
// from a Dry/Wet percentage, smoothed, with the block's ramp if it has one
export class Mix {
  readonly wet: Smoothed;
  constructor(percent: number, sampleRate: number) { this.wet = new Smoothed(percent / 100, sampleRate); }
  set(percent: number) { this.wet.set(Math.max(0, Math.min(1, percent / 100))); }
  // Fills `w[0..frames)` with the wet gain per sample; returns true when it
  // varied over the block (else every entry is w[0])
  fill(w: Float32Array, frames: number, ramp: [number, number] | undefined): boolean {
    const wet = this.wet;
    if (ramp) {
      const from = Math.max(0, Math.min(1, ramp[0] / 100)), to = Math.max(0, Math.min(1, ramp[1] / 100));
      const step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) w[i] = from + step * i;
      wet.value = wet.target = to;
      return true;
    }
    if (!wet.moving) { w[0] = wet.value; return false; }
    for (let i = 0; i < frames; i++) { wet.tick(); w[i] = wet.value; }
    return true;
  }
}
