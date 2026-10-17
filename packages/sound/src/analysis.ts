// Measuring sounds: levels, frequencies, pitch and spectra. The tests use
// these to check what the renderer makes, since nothing can listen.

export function peak(x: Float32Array) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export function rms(x: Float32Array, start = 0, length = x.length - start) {
  const end = Math.min(x.length, start + length);
  let sum = 0;
  for (let i = start; i < end; i++) sum += x[i] * x[i];
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

export function mean(x: Float32Array) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  return x.length ? sum / x.length : 0;
}

export const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

// RMS over a short window around `time` seconds
export const levelAt = (x: Float32Array, sampleRate: number, time: number, window = 0.01) =>
  rms(x, Math.max(0, Math.round((time - window / 2) * sampleRate)), Math.round(window * sampleRate));

const hann = (i: number, n: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

// The amplitude of one frequency (a sine of amplitude A reads A), Hann-windowed
export function amplitudeAt(x: Float32Array, sampleRate: number, hz: number, start = 0, length = x.length - start) {
  const n = Math.min(length, x.length - start);
  const w = (2 * Math.PI * hz) / sampleRate;
  let re = 0, im = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const h = hann(i, n);
    const v = x[start + i] * h;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
    norm += h;
  }
  return norm > 0 ? (2 * Math.hypot(re, im)) / norm : 0;
}

// In-place radix-2 FFT
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        const a = i + k, b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Power per bin (size/2 bins of sampleRate/size Hz) of a Hann-windowed frame
export function powerSpectrum(x: Float32Array, start: number, size: number) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size && start + i < x.length; i++) re[i] = x[start + i] * hann(i, size);
  fft(re, im);
  const power = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

// The share of a frame's energy between two frequencies
export function bandShare(x: Float32Array, sampleRate: number, lowHz: number, highHz: number, start = 0, size = 8192) {
  const power = powerSpectrum(x, start, size);
  let band = 0, total = 0;
  power.forEach((p, k) => {
    const hz = (k * sampleRate) / size;
    total += p;
    if (hz >= lowHz && hz <= highHz) band += p;
  });
  return total > 0 ? band / total : 0;
}

// Where a frame's energy is centred, in Hz
export function spectralCentroid(x: Float32Array, sampleRate: number, start = 0, size = 4096) {
  const power = powerSpectrum(x, start, size);
  let weighted = 0, total = 0;
  power.forEach((p, k) => {
    weighted += p * ((k * sampleRate) / size);
    total += p;
  });
  return total > 0 ? weighted / total : 0;
}

// How far a stretch of sound is from repeating every 1/hz seconds: 0 when it
// repeats exactly, about 1 when unrelated (squared difference against the
// signal one period later, over their energy)
export function periodicity(x: Float32Array, sampleRate: number, hz: number, start = 0, length = 4096) {
  const lag = sampleRate / hz;
  const whole = Math.floor(lag);
  const frac = lag - whole;
  const end = Math.min(start + length, x.length - whole - 1);
  let diff = 0, energy = 0;
  for (let j = start; j < end; j++) {
    const later = x[j + whole] + (x[j + whole + 1] - x[j + whole]) * frac;
    diff += (x[j] - later) * (x[j] - later);
    energy += x[j] * x[j] + later * later;
  }
  return energy > 0 ? diff / energy : 1;
}

// Fundamental frequency (YIN), or 0 if nothing periodic is found
export function estimatePitch(
  x: Float32Array, sampleRate: number, start = 0, length = 4096, minHz = 30, maxHz = 5000
) {
  const n = Math.min(length, x.length - start);
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(n / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const window = n - maxLag;
  if (window <= 0 || maxLag <= minLag) return 0;

  const d = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1 && lag + window <= x.length - start; lag++) {
    let sum = 0;
    for (let j = 0; j < window; j++) {
      const diff = x[start + j] - x[start + j + lag];
      sum += diff * diff;
    }
    d[lag] = sum;
  }
  // Cumulative mean normalized difference
  const cmnd = new Float64Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    running += d[lag];
    cmnd[lag] = running > 0 ? (d[lag] * lag) / running : 1;
  }

  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < 0.1) {
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    let lowest = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) if (cmnd[lag] < lowest) { lowest = cmnd[lag]; best = lag; }
    if (lowest > 0.35) return 0;
  }
  // Parabolic interpolation around the minimum
  const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
  const shift = a + c - 2 * b !== 0 ? (a - c) / (2 * (a + c - 2 * b)) : 0;
  return sampleRate / (best + shift);
}

// ---------------------------------------------------------------- loudness

// One RBJ biquad over a signal
function biquad(x: Float32Array, b: [number, number, number], a: [number, number, number]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

// ITU-R BS.1770 K-weighting: a +4 dB shelf above ~1.5 kHz (the head) and a
// highpass at 38 Hz, designed for any sample rate. Both stages as RBJ biquad
// coefficients, shared by the offline measure and the streaming meter.
type Coefficients = { b: [number, number, number]; a: [number, number, number] };

export function kWeightStages(sampleRate: number): [Coefficients, Coefficients] {
  let w = (2 * Math.PI * 1500) / sampleRate;
  const A = Math.pow(10, 4 / 40);
  let alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  let cos = Math.cos(w);
  const root = 2 * Math.sqrt(A) * alpha;
  const shelf = {
    b: [A * ((A + 1) + (A - 1) * cos + root), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - root)],
    a: [(A + 1) - (A - 1) * cos + root, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - root]
  } as Coefficients;
  w = (2 * Math.PI * 38) / sampleRate;
  alpha = Math.sin(w) / (2 * 0.5);
  cos = Math.cos(w);
  const highpass = {
    b: [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2],
    a: [1 + alpha, -2 * cos, 1 - alpha]
  } as Coefficients;
  return [shelf, highpass];
}

export function kWeight(x: Float32Array, sampleRate: number) {
  const [shelf, highpass] = kWeightStages(sampleRate);
  return biquad(biquad(x, shelf.b, shelf.a), highpass.b, highpass.a);
}

// The loudest moment, in LUFS: K-weighted power over the loudest `window`
// seconds (BS.1770, both channels summed). A sound shorter than the window
// is measured with silence after it, so a short click reads quieter than
// a held note of the same level, as it sounds.
export function loudness(left: Float32Array, right: Float32Array, sampleRate: number, window = 0.1) {
  const n = Math.max(1, Math.round(window * sampleRate));
  const l = kWeight(left, sampleRate);
  const r = kWeight(right, sampleRate);
  let sum = 0, loudest = 0;
  for (let i = 0; i < l.length; i++) {
    sum += l[i] * l[i] + r[i] * r[i];
    if (i >= n) sum -= l[i - n] * l[i - n] + r[i - n] * r[i - n];
    loudest = Math.max(loudest, sum);
  }
  return -0.691 + 10 * Math.log10(Math.max(loudest, 1e-20) / n);
}

// Loudness as a stream (BS.1770-4 / EBU R128): feed it blocks of samples as
// they arrive. Momentary is the last 400 ms, short-term the last 3 s,
// integrated the gated mean since the last reset. True peak is the largest
// sample of the signal at 4x its rate. `loudness` above is the offline
// version of the same weighting.
const TP_TAPS = 12; // per phase
const TP_PHASES = 4;
const oversampler = (() => {
  // Windowed-sinc interpolation, one filter per phase
  const kernel: Float64Array[] = [];
  for (let p = 1; p < TP_PHASES; p++) {
    const k = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let i = 0; i < TP_TAPS; i++) {
      const t = i - (TP_TAPS / 2 - 1) - p / TP_PHASES; // distance from the new sample
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TP_TAPS / 2));
      k[i] = sinc * win;
      sum += k[i];
    }
    for (let i = 0; i < TP_TAPS; i++) k[i] /= sum; // unity gain at DC
    kernel.push(k);
  }
  return kernel;
})();

class Biquad {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  c: Coefficients;
  constructor(c: Coefficients) { this.c = c; }
  run(x: number) {
    const { b, a } = this.c;
    const v = (b[0] * x + b[1] * this.x1 + b[2] * this.x2 - a[1] * this.y1 - a[2] * this.y2) / a[0];
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = v;
    return v;
  }
}

const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-20));

export class LoudnessMeter {
  readonly sampleRate: number;
  private stages: Biquad[][];
  private step: number;            // samples in a 100 ms sub-block
  private fill = 0;
  private acc = 0;                 // K-weighted power in the sub-block so far (both channels)
  private recent: number[] = [];   // mean squares of the last 30 sub-blocks
  private blocks: number[] = [];   // every 400 ms block's mean square since reset
  private history: Float64Array[]; // last TP_TAPS samples per channel, for true peak
  private tp = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.step = Math.round(0.1 * sampleRate);
    const [shelf, highpass] = kWeightStages(sampleRate);
    this.stages = [0, 1].map(() => [new Biquad(shelf), new Biquad(highpass)]);
    this.history = [new Float64Array(TP_TAPS), new Float64Array(TP_TAPS)];
  }

  push(left: Float32Array, right: Float32Array) {
    for (let i = 0; i < left.length; i++) {
      this.truePeakSample(0, left[i]);
      this.truePeakSample(1, right[i]);
      const l = this.stages[0][1].run(this.stages[0][0].run(left[i]));
      const r = this.stages[1][1].run(this.stages[1][0].run(right[i]));
      this.acc += l * l + r * r;
      if (++this.fill === this.step) {
        this.recent.push(this.acc / this.step);
        if (this.recent.length > 30) this.recent.shift();
        if (this.recent.length >= 4) this.blocks.push(this.mean(4));
        this.acc = 0;
        this.fill = 0;
      }
    }
  }

  private truePeakSample(ch: number, v: number) {
    const h = this.history[ch];
    h.copyWithin(0, 1);
    h[TP_TAPS - 1] = v;
    this.tp = Math.max(this.tp, Math.abs(v));
    for (const k of oversampler) {
      let y = 0;
      for (let i = 0; i < TP_TAPS; i++) y += k[i] * h[i];
      this.tp = Math.max(this.tp, Math.abs(y));
    }
  }

  private mean(last: number) {
    const from = Math.max(0, this.recent.length - last);
    let sum = 0;
    for (let i = from; i < this.recent.length; i++) sum += this.recent[i];
    return sum / (this.recent.length - from);
  }

  get momentary() { return this.recent.length >= 4 ? lufs(this.mean(4)) : -Infinity; }
  get shortTerm() { return this.recent.length >= 4 ? lufs(this.mean(30)) : -Infinity; }

  // Blocks above -70 LUFS, then those within 10 LU of their mean
  get integrated() {
    const loud = this.blocks.filter((p) => lufs(p) > -70);
    if (!loud.length) return -Infinity;
    const gate = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
    const kept = loud.filter((p) => lufs(p) > gate);
    return kept.length ? lufs(kept.reduce((a, b) => a + b, 0) / kept.length) : -Infinity;
  }

  // dBTP, the highest since reset
  get truePeak() { return toDb(this.tp); }

  reset() {
    this.blocks = [];
    this.tp = 0;
  }
}
