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
// highpass at 38 Hz, designed for any sample rate
export function kWeight(x: Float32Array, sampleRate: number) {
  let w = (2 * Math.PI * 1500) / sampleRate;
  const A = Math.pow(10, 4 / 40);
  let alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  let cos = Math.cos(w);
  const root = 2 * Math.sqrt(A) * alpha;
  const shelved = biquad(x,
    [A * ((A + 1) + (A - 1) * cos + root), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - root)],
    [(A + 1) - (A - 1) * cos + root, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - root]);
  w = (2 * Math.PI * 38) / sampleRate;
  alpha = Math.sin(w) / (2 * 0.5);
  cos = Math.cos(w);
  return biquad(shelved, [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2], [1 + alpha, -2 * cos, 1 - alpha]);
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
