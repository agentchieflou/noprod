// Time-stretch and pitch-shift: a transient-aware phase vocoder, built from
// the papers.
//
//  - The phase vocoder: a short-time Fourier transform read at one hop and
//    written at another, each bin's phase advanced by its own measured
//    frequency so a stretched sine stays a sine.
//  - Identity phase locking (Laroche & Dolson, "Improved phase vocoder
//    time-scale modification of audio", 1999): only the spectral peaks are
//    advanced; the bins around each peak keep their analysed phase relative
//    to it, so a partial's whole lobe turns as one and tones don't phase.
//    Turning a region as one is a single rotation per peak.
//  - Transients (after Röbel's transient preservation): onsets are found by
//    spectral flux ahead of the frames, and placed to a millisecond. The
//    frames that see an onset are read at the hop they're written at, with
//    their analysed phases (a phase reset), so they put the original back
//    sample for sample and the attack is as sharp as it was. The frames
//    before it are steered so the attack lands exactly where the ratio puts
//    it; the time not stretched there is made up between onsets.
//  - Pitch shift: stretch by the pitch factor, then resample (windowed sinc).
//    Formants are kept, if asked, by moving each frame's spectral envelope
//    (a line over its peaks, smoothed by liftering its cepstrum) back to
//    where it was before the resample.
//  - Stereo: every channel turns by the same per-bin rotation, measured on
//    their sum (or, where they cancel, their difference), so the phase and
//    level differences between channels (the image) are kept exactly.
//
// Offline in one call (`stretch`), or block by block (`Stretcher`) for an
// AudioWorklet. No randomness: the same input and settings give the same
// output.

export type StretchMode = 'complex' | 'beats' | 'tones';

export interface StretchOptions {
  sampleRate: number;
  ratio?: number;        // output length over input length (default 1)
  semitones?: number;    // pitch shift, duration kept (default 0)
  formants?: boolean;    // keep the spectral envelope when shifting (default false)
  mode?: StretchMode;    // default 'complex'
}

// Live's Complex Pro, Beats and Tones. `window` is the frame length in
// seconds (rounded to a power of two in samples); `transients` how keenly
// onsets are found (0: never).
export const STRETCH_MODES: Record<StretchMode, { window: number; transients: number; label: string }> = {
  complex: { window: 0.085, transients: 1, label: 'Complex' },
  beats: { window: 0.043, transients: 1.6, label: 'Beats' },
  tones: { window: 0.17, transients: 0, label: 'Tones' }
};

const TAU = 2 * Math.PI;
// How many frames ahead of an onset its timing is steered, in frame lengths
const STEER = 2;
const pow2 = (x: number) => 2 ** Math.round(Math.log2(x));
const wrap = (x: number) => x - TAU * Math.round(x / TAU);

// ---------------------------------------------------------------------- FFT

// Radix-2, in place, each stage's twiddles precomputed side by side.
// `inverse` leaves the 1/n to the caller.
class FFT {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    // A stage of half-size h keeps its twiddles at [h, 2h)
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let h = 1; h < n; h <<= 1) {
      for (let k = 0; k < h; k++) {
        this.cos[h + k] = Math.cos((Math.PI * k) / h);
        this.sin[h + k] = -Math.sin((Math.PI * k) / h);
      }
    }
    this.rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      this.rev[i] = j;
    }
  }

  transform(re: Float64Array, im: Float64Array, inverse = false) {
    // An inverse is a forward transform with real and imaginary swapped
    if (inverse) [re, im] = [im, re];
    const { n, rev, cos, sin } = this;
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // The first two stages at once: their twiddles are 1 and −i
    for (let i = 0; i < n; i += 4) {
      const r0 = re[i] + re[i + 1], i0 = im[i] + im[i + 1];
      const r1 = re[i] - re[i + 1], i1 = im[i] - im[i + 1];
      const r2 = re[i + 2] + re[i + 3], i2 = im[i + 2] + im[i + 3];
      const r3 = re[i + 2] - re[i + 3], i3 = im[i + 2] - im[i + 3];
      re[i] = r0 + r2; im[i] = i0 + i2;
      re[i + 2] = r0 - r2; im[i + 2] = i0 - i2;
      re[i + 1] = r1 + i3; im[i + 1] = i1 - r3;
      re[i + 3] = r1 - i3; im[i + 3] = i1 + r3;
    }
    for (let half = 4; half < n; half <<= 1) {
      for (let i = 0; i < n; i += half << 1) {
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const wr = cos[half + k], wi = sin[half + k];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

// n samples from absolute index a, windowed
function readWindowed(q: Queue, a: number, window: Float64Array, out: Float64Array) {
  const n = window.length;
  if (a >= q.base && a + n <= q.length) {
    const d = q.data, o = a - q.base;
    for (let i = 0; i < n; i++) out[i] = d[o + i] * window[i];
  } else for (let i = 0; i < n; i++) out[i] = q.at(a + i) * window[i];
}

const hannWindow = (n: number) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((TAU * i) / n));

// ------------------------------------------------------------ sample queues

// A growing run of samples, indexed absolutely; what's been used is dropped
class Queue {
  data: Float32Array;
  base = 0;     // the absolute index of data[0]
  length = 0;   // absolute index one past the last sample

  constructor(size = 4096) { this.data = new Float32Array(size); }

  push(x: ArrayLike<number>, from = 0, to = x.length) {
    this.reserve(to - from);
    const at = this.length - this.base;
    for (let i = from; i < to; i++) this.data[at + i - from] = x[i];
    this.length += to - from;
  }

  pushZeros(count: number) {
    this.reserve(count);
    this.data.fill(0, this.length - this.base, this.length - this.base + count);
    this.length += count;
  }

  // The sample at absolute index i (zero outside what's held)
  at(i: number) {
    return i >= this.base && i < this.length ? this.data[i - this.base] : 0;
  }

  dropBefore(i: number) {
    const drop = Math.min(i, this.length) - this.base;
    if (drop <= 0 || drop < this.data.length / 2) return;
    this.data.copyWithin(0, drop, this.length - this.base);
    this.base += drop;
  }

  private reserve(count: number) {
    const need = this.length - this.base + count;
    if (need <= this.data.length) return;
    const grown = new Float32Array(Math.max(need, this.data.length * 2));
    grown.set(this.data.subarray(0, this.length - this.base));
    this.data = grown;
  }
}

// ---------------------------------------------------------- onset detection

// Spectral flux: the summed rise of each bin's log magnitude from one short
// frame to the next, picked where it peaks well above its recent average
class OnsetDetector {
  readonly size: number;
  readonly hop: number;
  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly tmp: Float64Array;
  private readonly last: Float64Array;
  private readonly flux: number[] = [];
  private readonly keenness: number;
  private readonly gap: number;
  private lastOnset = -Infinity;
  next: number;                  // the next frame's start
  readonly onsets: number[] = []; // where each onset starts
  readonly block: number;

  constructor(sampleRate: number, keenness: number) {
    this.size = pow2(sampleRate * 0.0213);
    this.hop = this.size / 2;
    this.fft = new FFT(this.size);
    this.window = hannWindow(this.size);
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    this.tmp = new Float64Array(this.size);
    this.last = new Float64Array(this.size / 2 + 1);
    this.keenness = keenness;
    this.gap = Math.round(sampleRate * (keenness > 1.2 ? 0.03 : 0.05));
    this.block = Math.max(16, Math.round(sampleRate * 0.001));
    this.next = -this.size;
  }

  // Frames are analysed while their whole window has arrived, two at a
  // time (one as the real part of a transform, one as the imaginary)
  run(inputs: Queue[], until: number) {
    const { size, hop, re, im, window, tmp } = this;
    while (this.next + hop + size <= until) {
      re.fill(0); im.fill(0);
      for (const q of inputs) {
        readWindowed(q, this.next, window, tmp);
        for (let i = 0; i < size; i++) re[i] += tmp[i];
        readWindowed(q, this.next + hop, window, tmp);
        for (let i = 0; i < size; i++) im[i] += tmp[i];
      }
      this.fft.transform(re, im);
      for (let half = 0; half < 2; half++) {
        let flux = 0;
        const { last } = this;
        for (let k = 0; k <= size / 2; k++) {
          const m = (size - k) & (size - 1);
          const x = half ? im[k] + im[m] : re[k] + re[m];
          const y = half ? re[m] - re[k] : im[k] - im[m];
          // log(1 + γ|X|), with a full-scale sine at about 1000
          const level = Math.log1p((2000 / size) * Math.hypot(x, y));
          if (level > last[k]) flux += level - last[k];
          last[k] = level;
        }
        this.flux.push(flux);
        this.pick(inputs, this.next + (half - 1) * hop);
      }
      this.next += 2 * hop;
    }
  }

  // Whether the frame before the newest one (starting at `start`) is an onset
  private pick(inputs: Queue[], start: number) {
    const f = this.flux, j = f.length - 2;
    if (j < 1) return;
    if (f.length > 64) f.splice(0, f.length - 32);
    if (!(f[j] > f[j - 1] && f[j] >= f[j + 1])) return;
    let sum = 0, count = 0;
    for (let i = Math.max(0, j - 8); i < j - 1; i++) { sum += f[i]; count++; }
    const average = count ? sum / count : 0;
    // A rise of about 6 dB across a sixth of the bins, at the least
    const floor = (this.size / 12) * 0.7 / this.keenness;
    if (f[j] > Math.max(floor, (3 / this.keenness) * average) && start - this.lastOnset >= this.gap) {
      const at = this.locate(inputs, start);
      this.onsets.push(at);
      this.lastOnset = at;
    }
  }

  // The frame only says roughly where: the onset is where the amplitude, in
  // blocks of about a millisecond, jumps the most
  private locate(inputs: Queue[], start: number) {
    const block = this.block;
    let best = start, jump = -Infinity, prev = 0;
    for (let b = start - this.hop - block; b < start + this.size; b += block) {
      let e = 0;
      for (const q of inputs) for (let i = b; i < b + block; i++) e += q.at(i) * q.at(i);
      const level = Math.sqrt(e / block);
      if (b >= start - this.hop && level - prev > jump) { jump = level - prev; best = b; }
      prev = level;
    }
    return best;
  }
}

// ------------------------------------------------------------- resampling

// A Blackman-windowed sinc, tabulated: reads a queue `step` samples per
// output sample, low-passed below the slower of the two rates
class Resampler {
  readonly step: number;
  readonly reach: number;   // input samples either side of a read
  private readonly scale: number;
  private readonly table: Float64Array;
  private static readonly ZEROS = 16;
  private static readonly PER = 512;

  constructor(step: number) {
    this.step = step;
    this.scale = Math.min(1, 1 / step) * 0.94;
    const { ZEROS, PER } = Resampler;
    this.table = new Float64Array(ZEROS * PER + 2);
    for (let i = 0; i <= ZEROS * PER; i++) {
      const u = i / PER, x = Math.PI * u;
      const sinc = u === 0 ? 1 : Math.sin(x) / x;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * u) / ZEROS) + 0.08 * Math.cos((TAU * u) / ZEROS);
      this.table[i] = this.scale * sinc * w;
    }
    this.reach = Math.ceil(ZEROS / this.scale) + 1;
  }

  // The value at fractional position x of a queue
  read(q: Queue, x: number) {
    const { table, scale, reach } = this;
    const { ZEROS, PER } = Resampler;
    const centre = Math.floor(x);
    const from = centre - reach + 1, to = centre + reach;
    const data = q.data, base = q.base;
    if (from < base || to >= q.length) {
      let sum = 0;
      for (let i = from; i <= to; i++) {
        const u = Math.abs(x - i) * scale * PER;
        if (u >= ZEROS * PER) continue;
        const j = u | 0;
        sum += q.at(i) * (table[j] + (table[j + 1] - table[j]) * (u - j));
      }
      return sum;
    }
    // The taps sit a fixed table step apart, either side of x
    const step = scale * PER, limit = ZEROS * PER;
    let sum = 0;
    let u = (x - centre) * step;
    for (let i = centre - base; i >= from - base && u < limit; i--, u += step) {
      const j = u | 0;
      sum += data[i] * (table[j] + (table[j + 1] - table[j]) * (u - j));
    }
    u = (centre + 1 - x) * step;
    for (let i = centre + 1 - base; i <= to - base && u < limit; i++, u += step) {
      const j = u | 0;
      sum += data[i] * (table[j] + (table[j + 1] - table[j]) * (u - j));
    }
    return sum;
  }
}

// ---------------------------------------------------------------- stretcher

export class Stretcher {
  readonly channels: number;
  readonly ratio: number;
  readonly semitones: number;
  readonly mode: StretchMode;
  private readonly sampleRate: number;
  private readonly formants: boolean;
  private readonly pitch: number;  // frequency factor
  private readonly r: number;      // the vocoder's own stretch
  private readonly bypass: boolean;
  private readonly n: number;
  private readonly hs: number;     // synthesis hop
  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly norm: number;
  private readonly detector: OnsetDetector | null;
  private readonly resampler: Resampler | null;
  private readonly lifter: number;

  private readonly input: Queue[];
  private readonly stretched: Queue[];
  private readonly output: Queue[];
  private ended = false;
  private inputLength = 0;
  private finalLength = Infinity;
  private stretchedEnd = Infinity;  // the vocoder output needed, once ended

  // Frame state
  private a: number;       // analysis position of the next frame
  private s: number;       // its synthesis position
  private rigid = false;   // the next frame is on an onset: read at the synthesis hop, phases reset
  private first = true;
  private onsetIndex = 0;
  private readonly acc: Float64Array[];
  private readonly re: Float64Array[];  // one pair of channels per transform
  private readonly im: Float64Array[];
  private readonly specRe: Float64Array[]; // each channel's half spectrum
  private readonly specIm: Float64Array[];
  private readonly refRe: Float64Array;
  private readonly refIm: Float64Array;
  private readonly prevRe: Float64Array;
  private readonly prevIm: Float64Array;
  private readonly diffRe: Float64Array;
  private readonly diffIm: Float64Array;
  private readonly prevDiffRe: Float64Array;
  private readonly prevDiffIm: Float64Array;
  private readonly power: Float64Array;
  private readonly theta: Float64Array;     // each bin's rotation, analysis to synthesis
  private readonly rotRe: Float64Array;
  private readonly rotIm: Float64Array;
  private readonly gain: Float64Array;
  private readonly envelope: Float64Array;
  private readonly cepFft: FFT;
  private readonly cepRe: Float64Array;
  private readonly cepIm: Float64Array;
  private readonly line: Float64Array;
  private readonly peakAt: Float64Array;
  private readonly peakLevel: Float64Array;
  private readonly peaks: Int32Array;
  private prevHa = 0;
  private resamplePos = 0;  // the next output sample's index
  private block = new Float32Array(0);

  constructor(channels: number, options: StretchOptions) {
    this.channels = channels;
    this.sampleRate = options.sampleRate;
    this.ratio = options.ratio ?? 1;
    this.semitones = options.semitones ?? 0;
    this.mode = options.mode ?? 'complex';
    this.formants = !!options.formants;
    if (!(this.ratio > 0) || !Number.isFinite(this.ratio)) throw new Error(`stretch: bad ratio ${this.ratio}`);
    this.pitch = 2 ** (this.semitones / 12);
    this.r = this.ratio * this.pitch;
    this.bypass = this.ratio === 1 && this.semitones === 0;

    const preset = STRETCH_MODES[this.mode];
    const n = this.n = pow2(this.sampleRate * preset.window);
    // Read at most a quarter frame per hop, so each bin's frequency is
    // measured without ambiguity: compressing writes at a shorter hop
    this.hs = n / (this.r >= 1 ? 4 : this.r >= 0.5 ? 8 : this.r >= 0.25 ? 16 : 32);
    this.fft = new FFT(n);
    this.window = hannWindow(n);
    this.norm = 1 / (n * ((3 / 8) * (n / this.hs)));  // the IFFT's 1/n, and Hann² overlap
    this.detector = preset.transients > 0 ? new OnsetDetector(this.sampleRate, preset.transients) : null;
    this.resampler = this.pitch !== 1 ? new Resampler(this.pitch) : null;
    // A 4 ms quefrency cut: below the period of voices up to 250 Hz
    this.lifter = Math.max(8, Math.round(this.sampleRate * 0.004));

    const half = n / 2 + 1;
    this.input = Array.from({ length: channels }, () => new Queue());
    this.stretched = Array.from({ length: channels }, () => new Queue());
    this.output = Array.from({ length: channels }, () => new Queue());
    this.acc = Array.from({ length: channels }, () => new Float64Array(2 * n));
    const pairs = Math.ceil(channels / 2);
    this.re = Array.from({ length: pairs }, () => new Float64Array(n));
    this.im = Array.from({ length: pairs }, () => new Float64Array(n));
    this.specRe = Array.from({ length: channels }, () => new Float64Array(half));
    this.specIm = Array.from({ length: channels }, () => new Float64Array(half));
    this.refRe = new Float64Array(half);
    this.refIm = new Float64Array(half);
    this.prevRe = new Float64Array(half);
    this.prevIm = new Float64Array(half);
    this.diffRe = new Float64Array(half);
    this.diffIm = new Float64Array(half);
    this.prevDiffRe = new Float64Array(half);
    this.prevDiffIm = new Float64Array(half);
    this.power = new Float64Array(half);
    this.theta = new Float64Array(half);
    this.rotRe = new Float64Array(half);
    this.rotIm = new Float64Array(half);
    this.gain = new Float64Array(half);
    this.envelope = new Float64Array(half);
    this.cepFft = new FFT(n / 4);
    this.cepRe = new Float64Array(n / 4);
    this.cepIm = new Float64Array(n / 4);
    this.line = new Float64Array(n / 8 + 1);
    this.peakAt = new Float64Array(half);
    this.peakLevel = new Float64Array(half);
    this.peaks = new Int32Array(half);

    // The first frame ends a hop into the output, so every output sample
    // gets its full overlap
    this.s = -n + this.hs;
    this.a = Math.round(this.target(this.s));
  }

  // The frames' latency, in input samples: what must arrive before output starts
  get latency() {
    return this.bypass ? 0 : this.n * (3 + STEER) + (this.detector ? this.detector.size * 2 : 0);
  }

  // Where frame `s` should read, on the ratio's straight line (centre to centre)
  private target(s: number) {
    return (s + this.n / 2) / this.r - this.n / 2;
  }

  write(block: Float32Array[]) {
    if (this.ended) throw new Error('stretch: write after end');
    const length = block[0]?.length ?? 0;
    for (let c = 0; c < this.channels; c++) {
      const x = block[c] ?? block[0];
      if (this.bypass) this.output[c].push(x);
      else this.input[c].push(x);
    }
    this.inputLength += length;
    this.run();
  }

  // No more input: everything left comes out, to exactly length × ratio
  end() {
    if (this.ended) return;
    this.ended = true;
    this.finalLength = Math.round(this.inputLength * this.ratio);
    this.stretchedEnd = this.resampler
      ? Math.ceil((this.finalLength - 1) * this.pitch) + this.resampler.reach + 1
      : this.finalLength;
    this.run();
  }

  available() {
    const held = this.output[0].length - this.output[0].base;
    return this.ended ? Math.min(held, this.finalLength - this.output[0].base) : held;
  }

  // Moves up to out[0].length ready samples into `out`; returns how many
  read(out: Float32Array[]) {
    const count = Math.max(0, Math.min(out[0].length, this.available()));
    for (let c = 0; c < this.channels; c++) {
      const q = this.output[c];
      if (out[c]) out[c].set(q.data.subarray(0, count));
      q.data.copyWithin(0, count, q.length - q.base);
      q.base += count;
    }
    return count;
  }

  private run() {
    if (this.bypass) return;
    const n = this.n, det = this.detector;
    const known = this.ended ? Infinity : this.inputLength;
    // (past the end, the input reads as silence)
    if (det) det.run(this.input, this.inputLength + (this.ended ? det.size * 2 : 0));
    const detected = det ? (this.ended ? Infinity : det.next - det.hop * 2) : Infinity;
    // A frame goes once its input has arrived and onsets have been looked
    // for far enough ahead to decide where the next one reads
    const reach = (2 + STEER) * n + Math.ceil((2 * this.hs) / this.r) + (det ? det.size : 0);
    while (this.s < this.stretchedEnd) {
      if (this.a + n > known || this.a + reach > detected) break;
      this.frame();
    }
    if (this.ended && this.s >= this.stretchedEnd) this.flushAcc();
    this.resample();
    const keep = Math.min(this.a, det ? det.next : Infinity) - n;
    for (const q of this.input) q.dropBefore(keep);
  }

  private frame() {
    const { n, hs, window, fft, channels } = this;
    const half = n / 2 + 1;
    const a = this.a;

    // Analysis: two channels per complex transform (one as the real part,
    // one as the imaginary), separated by symmetry
    for (let p = 0; p * 2 < channels; p++) {
      const re = this.re[p], im = this.im[p];
      const l = this.input[2 * p], r = 2 * p + 1 < channels ? this.input[2 * p + 1] : null;
      readWindowed(l, a, window, re);
      if (r) readWindowed(r, a, window, im);
      else im.fill(0);
      fft.transform(re, im);
      const lr = this.specRe[2 * p], li = this.specIm[2 * p];
      for (let k = 0; k < half; k++) {
        const m = (n - k) & (n - 1);
        lr[k] = (re[k] + re[m]) / 2; li[k] = (im[k] - im[m]) / 2;
        if (r) {
          this.specRe[2 * p + 1][k] = (im[k] + im[m]) / 2;
          this.specIm[2 * p + 1][k] = (re[m] - re[k]) / 2;
        }
      }
    }
    // The phases are measured on the channels' sum, or (where they cancel,
    // as in side-only sound) on the first two's difference; peaks are
    // picked on their total power
    const { refRe, refIm, prevRe, prevIm, power, theta, rotRe, rotIm } = this;
    const { diffRe, diffIm, prevDiffRe, prevDiffIm } = this;
    let top = 0;
    for (let k = 0; k < half; k++) {
      let x = 0, y = 0, sum = 0;
      for (let c = 0; c < channels; c++) {
        const a = this.specRe[c][k], b = this.specIm[c][k];
        x += a; y += b; sum += a * a + b * b;
      }
      refRe[k] = x; refIm[k] = y;
      if (channels > 1) {
        diffRe[k] = this.specRe[0][k] - this.specRe[1][k];
        diffIm[k] = this.specIm[0][k] - this.specIm[1][k];
      }
      power[k] = sum;
      if (sum > top) top = sum;
    }

    // Phases: reset on an onset, else advance each peak by its frequency
    if (this.rigid || this.first) {
      theta.fill(0);
      rotRe.fill(1); rotIm.fill(0);
    } else {
      const ha = this.prevHa;
      const floor = top * 1e-9;
      let count = 0;
      for (let k = 1; k < half - 1; k++) {
        const v = power[k];
        if (v > floor && v > power[k - 1] && v >= power[k + 1] && (k < 2 || v > power[k - 2]) && (k + 2 >= half || v >= power[k + 2])) {
          this.peaks[count++] = k;
        }
      }
      let from = 0;
      for (let i = 0; i < count; i++) {
        const k = this.peaks[i];
        // The analysed phase advance, unwrapped around the bin's own frequency
        const side = channels > 1 && diffRe[k] ** 2 + diffIm[k] ** 2 > refRe[k] ** 2 + refIm[k] ** 2;
        const xr = side ? diffRe : refRe, xi = side ? diffIm : refIm;
        const pr = side ? prevDiffRe : prevRe, pi = side ? prevDiffIm : prevIm;
        const dRe = xr[k] * pr[k] + xi[k] * pi[k];
        const dIm = xi[k] * pr[k] - xr[k] * pi[k];
        const dPhi = Math.atan2(dIm, dRe);
        const omega = (TAU * k) / n;
        const freq = omega + wrap(dPhi - omega * ha) / ha;
        const t = wrap(theta[k] + freq * hs - dPhi);
        // The region around the peak: up to the lowest bin before the next one
        let to = half - 1;
        if (i + 1 < count) {
          const next = this.peaks[i + 1];
          to = k;
          for (let j = k + 1; j < next; j++) if (power[j] < power[to]) to = j;
        }
        const cr = Math.cos(t), ci = Math.sin(t);
        for (let j = from; j <= to; j++) { theta[j] = t; rotRe[j] = cr; rotIm[j] = ci; }
        from = to + 1;
      }
      // (no peaks: a silent frame keeps its rotations.) DC and Nyquist stay
      // real, or the paired transform would leak one channel into the other
      theta[0] = theta[half - 1] = 0;
      rotRe[0] = rotRe[half - 1] = 1;
      rotIm[0] = rotIm[half - 1] = 0;
    }
    prevRe.set(refRe);
    prevIm.set(refIm);
    prevDiffRe.set(diffRe);
    prevDiffIm.set(diffIm);

    if (this.formants && this.pitch !== 1) this.envelopeGain(half);

    // Synthesis: every channel turned by the same rotation, so the image holds
    const gain = this.formants && this.pitch !== 1 ? this.gain : null;
    for (let p = 0; p * 2 < channels; p++) {
      const re = this.re[p], im = this.im[p];
      const hasR = 2 * p + 1 < channels;
      const lr = this.specRe[2 * p], li = this.specIm[2 * p];
      const rr = hasR ? this.specRe[2 * p + 1] : null, ri = hasR ? this.specIm[2 * p + 1] : null;
      for (let k = 0; k < half; k++) {
        const g = gain ? gain[k] : 1;
        const cr = rotRe[k] * g, ci = rotIm[k] * g;
        const ar = lr[k] * cr - li[k] * ci, ai = lr[k] * ci + li[k] * cr;
        let br = 0, bi = 0;
        if (rr && ri) { br = rr[k] * cr - ri[k] * ci; bi = rr[k] * ci + ri[k] * cr; }
        // Z = A + iB at k, and its mirror conj(A) + i·conj(B) at n − k
        re[k] = ar - bi; im[k] = ai + br;
        if (k > 0 && k < n / 2) {
          const m = n - k;
          re[m] = ar + bi; im[m] = br - ai;
        }
      }
      fft.transform(re, im, true);
      const accL = this.acc[2 * p], accR = hasR ? this.acc[2 * p + 1] : null;
      for (let i = 0; i < n; i++) {
        const w = window[i] * this.norm;
        accL[i] += re[i] * w;
        if (accR) accR[i] += im[i] * w;
      }
    }

    // Everything before the next frame's start is final
    this.emit(hs);
    this.first = false;
    this.advance();
  }

  // Where the next frame reads, and whether it's on an onset
  private advance() {
    const { n, hs, r } = this;
    const sNext = this.s + hs;
    const nominal = hs / r;
    const det = this.detector;
    const onsets = det?.onsets ?? [];
    const pre = det ? det.block * 3 : 0, post = det ? det.block * 5 : 0;
    while (this.onsetIndex < onsets.length && onsets[this.onsetIndex] + post <= this.a) this.onsetIndex++;
    const t = onsets[this.onsetIndex];
    // On the ratio's line; or, coming up to an onset, on the line that puts
    // it exactly at t × r (frames that see it read at s + t − t·r). The
    // first frame on the synthesis grid to see it is the entry; the frames
    // before it head straight for the one before it on that line, which
    // doesn't see it yet, and step from there into the entry by the
    // synthesis hop.
    const near = t !== undefined && t - pre < this.a + n + STEER * n;
    const clamp = (x: number) => Math.min(nominal * 1.6, Math.max(nominal * 0.4, x));
    let ha = clamp(this.target(sNext) - this.a);
    if (near) {
      const shift = t - t * r;
      const sEntry = this.s + hs * Math.max(1, Math.floor((t * r - pre - n - this.s) / hs) + 1);
      if (sNext < sEntry) {
        const sBefore = sEntry - hs;
        ha = clamp(((sBefore + shift - this.a) * hs) / (sBefore - this.s));
      } else ha = Math.min(2 * hs, Math.max(1, sNext + shift - this.a));
    }
    // A frame that sees the onset is rigid, unless the timing has drifted
    // too far to make the time up
    this.rigid = near && t - pre < this.a + ha + n && t + post > this.a + ha &&
      Math.abs(this.target(this.s) - this.a) < 2 * n;
    ha = Math.max(1, Math.round(ha));
    this.prevHa = ha;
    this.a += ha;
    this.s = sNext;
  }

  // Moves `count` finished samples from the accumulators to the vocoder output
  private emit(count: number) {
    for (let c = 0; c < this.channels; c++) {
      const acc = this.acc[c], q = this.stretched[c];
      const from = Math.max(0, -this.s);   // output before 0 is the padding
      if (from < count) q.push(acc, from, count);
      acc.copyWithin(0, count);
      acc.fill(0, acc.length - count);
    }
  }

  private flushAcc() {
    const need = this.stretchedEnd - this.stretched[0].length;
    if (need <= 0) return;
    for (let c = 0; c < this.channels; c++) this.stretched[c].push(this.acc[c], 0, Math.min(need, this.n));
    if (need > this.n) for (const q of this.stretched) q.pushZeros(need - this.n);
  }

  private resample() {
    const st = this.stretched;
    if (!this.resampler) {
      for (let c = 0; c < this.channels; c++) {
        const from = this.output[c].length, to = Math.min(st[c].length, this.finalLength);
        if (to > from) this.output[c].push(st[c].data, from - st[c].base, to - st[c].base);
        st[c].dropBefore(to);
      }
      return;
    }
    const rs = this.resampler;
    const ready = st[0].length - rs.reach - 1;
    const done = this.ended && this.s >= this.stretchedEnd;
    let to = this.resamplePos;
    while (to < this.finalLength && (done || to * rs.step <= ready)) to++;
    if (to === this.resamplePos) return;
    const block = this.block.length >= to - this.resamplePos ? this.block : (this.block = new Float32Array(to - this.resamplePos));
    for (let c = 0; c < this.channels; c++) {
      for (let j = this.resamplePos; j < to; j++) block[j - this.resamplePos] = rs.read(st[c], j * rs.step);
      this.output[c].push(block, 0, to - this.resamplePos);
    }
    this.resamplePos = to;
    for (const q of st) q.dropBefore(Math.floor(this.resamplePos * rs.step) - rs.reach - 1);
  }

  // Formants: the gain that puts each frame's spectral envelope back where
  // it was once the resample has moved every frequency by the pitch factor.
  // The envelope runs over the harmonics' peaks, not through the valleys
  // between them (where a plain cepstrum would sink): a line through the
  // spectrum's local maxima, in log, smoothed by liftering its cepstrum.
  // It's smooth, so it's found on every 4th bin (a quarter-size transform).
  private envelopeGain(half: number) {
    const { cepRe, cepIm, envelope, gain, power, lifter } = this;
    const m = this.cepFft.n, d = this.n / m, spec = this.line;
    let top = 0;
    for (let k = 0; k < half; k++) top = Math.max(top, power[k]);
    const floor = top * 1e-12 + 1e-30;
    // Each 4th bin, on the line between the local maxima either side of
    // it (level beyond the first and the last). Each maximum's level and
    // place come from a parabola through it and its neighbours (in log),
    // since a harmonic seldom sits on a bin.
    const level = (k: number) => 0.5 * Math.log(power[k] + floor);
    const at = this.peakAt, height = this.peakLevel;
    let count = 0;
    for (let k = 1; k < half - 1; k++) {
      const v = power[k];
      if (v > top * 1e-9 && v >= power[k - 1] && v >= power[k + 1] && (k < 2 || v >= power[k - 2]) && (k + 2 >= half || v >= power[k + 2])) {
        const l = level(k - 1), c = level(k), r = level(k + 1);
        const bend = l - 2 * c + r;
        const shift = bend < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / bend)) : 0;
        at[count] = k + shift;
        height[count++] = c - 0.25 * (l - r) * shift;
      }
    }
    for (let j = 0, i = 0; j <= m / 2; j++) {
      const x = j * d;
      while (i < count && at[i] < x) i++;
      if (count === 0) spec[j] = level(Math.min(half - 1, x));
      else if (i === 0) spec[j] = height[0];
      else if (i === count) spec[j] = height[count - 1];
      else spec[j] = height[i - 1] + ((height[i] - height[i - 1]) * (x - at[i - 1])) / (at[i] - at[i - 1]);
    }
    for (let j = 0; j <= m / 2; j++) {
      cepRe[j] = spec[j]; cepIm[j] = 0;
      if (j > 0 && j < m / 2) { cepRe[m - j] = spec[j]; cepIm[m - j] = 0; }
    }
    this.cepFft.transform(cepRe, cepIm);
    // Keep the low quefrencies (a coefficient is still a sample of
    // quefrency, whatever the decimation): flat, then a short taper
    for (let q = 0; q < m; q++) {
      const t = Math.min(q, m - q);
      const keep = t < 0.75 * lifter ? 1 : t < lifter ? 0.5 + 0.5 * Math.cos((Math.PI * (t - 0.75 * lifter)) / (0.25 * lifter)) : 0;
      cepRe[q] *= keep / m;
      cepIm[q] = 0;
    }
    this.cepFft.transform(cepRe, cepIm);
    // Back to every bin, by linear interpolation
    for (let k = 0; k < half; k++) {
      const x = k / d, j = Math.min(m / 2 - 1, Math.floor(x));
      envelope[k] = cepRe[j] + (cepRe[j + 1] - cepRe[j]) * (x - j);
    }
    for (let k = 0; k < half; k++) {
      const x = Math.min(half - 1, k * this.pitch), j = Math.floor(x);
      const moved = j + 1 < half ? envelope[j] + (envelope[j + 1] - envelope[j]) * (x - j) : envelope[half - 1];
      gain[k] = Math.exp(Math.max(-4, Math.min(4, moved - envelope[k])));
    }
  }
}

// Stretches whole channels at once: each comes out `ratio` times as long
export function stretch(channels: Float32Array[], options: StretchOptions): Float32Array[] {
  const s = new Stretcher(channels.length, options);
  s.write(channels);
  s.end();
  const out = channels.map(() => new Float32Array(s.available()));
  s.read(out);
  return out;
}
