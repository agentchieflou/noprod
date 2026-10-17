// The master's limiter: a brickwall on the true peak, so the output never
// goes over the ceiling once a converter reconstructs it (ITU-R BS.1770's
// 4× oversampled peak, with the same interpolator the LoudnessMeter
// measures by). Lookahead, so a transient is turned down before it
// arrives; its latency is reported.
//
// Per sample: the true peak around the sample -> the gain it needs to
// sit at the ceiling -> an envelope that drops at once and recovers over
// Release -> a running minimum over the lookahead (so the gain is down
// before the peak, and stays down around it) -> a running average over
// the lookahead (so the gain moves in straight lines, never steps) ->
// applied to the signal delayed to meet it. The minimum's window is the
// average's plus a plateau wider than the interpolator, so around every
// peak the gain is flat and the peak between samples is scaled as the
// samples are.
//
// One thing a ramp can't do: where a bigger peak follows within the
// lookahead, its attack ramp starts inside the interpolator's window
// around the first, and a gain that moves across that window changes
// the peak between samples by a little (the outer taps' weights times
// the gain's travel). So the gain aims MARGIN_DB under the ceiling: the
// bound for the steepest ramp over the 2 ms box is about 0.04 dB, and
// the excess measured without the margin on the worst-case program is
// 1e-5 dB.

import { BLOCK, Smoothed, num, type DeviceKernel, type ParamValue } from './kernel.ts';

const LOOKAHEAD = 0.002;        // seconds
const PLATEAU = 16;             // frames the gain holds around a peak (the interpolator spans 12)
const TAPS = 12;                // the interpolator's, as analysis.ts's
const PHASES = 4;
const GROUP = TAPS / 2;         // frames from the newest sample to the interpolated points' far side
const MARGIN_DB = 0.05;
const MARGIN = Math.pow(10, -MARGIN_DB / 20);

// Windowed-sinc interpolation of the three points between two samples, as
// @noprod/sound's LoudnessMeter computes true peak
const KERNELS = (() => {
  const out: Float64Array[] = [];
  for (let p = 1; p < PHASES; p++) {
    const k = new Float64Array(TAPS);
    let sum = 0;
    for (let i = 0; i < TAPS; i++) {
      const t = i - (TAPS / 2 - 1) - p / PHASES;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TAPS / 2));
      k[i] = sinc * win;
      sum += k[i];
    }
    for (let i = 0; i < TAPS; i++) k[i] /= sum;
    out.push(k);
  }
  return out;
})();

export class Limiter implements DeviceKernel {
  readonly kind = 'limiter';
  readonly latency: number;
  private readonly sampleRate: number;
  private readonly box: number;           // frames averaged
  private readonly window: number;        // frames the minimum spans
  // the interpolator's history per channel, doubled so a window is contiguous
  private readonly histL = new Float64Array(TAPS * 2);
  private readonly histR = new Float64Array(TAPS * 2);
  private hist = 0;
  // the required gain's history, for the running minimum (a monotonic queue of indices)
  private readonly need: Float64Array;
  private readonly queue: Int32Array;
  private head = 0; private count = 0;
  private n = 0;                          // frames seen
  // the minimum's history, for the running average
  private readonly mins: Float64Array;
  private sum = 0;
  private sinceSum = 0;
  // the delayed signal
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private at = 0;
  private envelope = 1;                   // the required gain, recovering over Release
  private gain = 1;                       // the last gain applied
  private release = 0.1;                  // seconds
  private readonly ceiling: Smoothed;     // linear
  private primed = false;
  private readonly c = new Float32Array(BLOCK);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.box = Math.max(2, Math.round(LOOKAHEAD * sampleRate));
    this.window = this.box + PLATEAU + 1;
    this.latency = this.box + PLATEAU / 2 + GROUP - 1;
    this.need = new Float64Array(this.window);
    this.queue = new Int32Array(this.window + 1);
    this.mins = new Float64Array(this.box);
    // read before written, a ring of `latency` frames delays by `latency`
    this.delayL = new Float32Array(this.latency);
    this.delayR = new Float32Array(this.latency);
    this.ceiling = new Smoothed(Math.pow(10, -1 / 20), sampleRate);
    this.reset();
  }

  tail() { return this.latency; }

  set(name: string, value: ParamValue) {
    if (name === 'Ceiling') { this.ceiling.set(Math.pow(10, Math.min(0, num(value, -1)) / 20)); if (!this.primed) this.ceiling.snap(); }
    else if (name === 'Release') this.release = Math.max(0.001, num(value, 100) / 1000);
  }

  reduction() { return 20 * Math.log10(Math.max(1e-6, this.gain)); }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const { histL, histR, need, queue, mins, delayL, delayR, c, box, window } = this;
    const k1 = KERNELS[0], k2 = KERNELS[1], k3 = KERNELS[2];
    // The ceiling per sample: a lane, a glide, or one value
    const rc = ramps?.get('Ceiling');
    let ceilingVaries = true;
    if (rc) {
      const from = Math.pow(10, Math.min(0, rc[0]) / 20), to = Math.pow(10, Math.min(0, rc[1]) / 20), step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) c[i] = from + step * i;
      this.ceiling.value = this.ceiling.target = to;
    } else if (this.ceiling.moving) {
      const s = this.ceiling;
      for (let i = 0; i < frames; i++) { s.tick(); c[i] = s.value; }
    } else { c[0] = this.ceiling.value; ceilingVaries = false; }
    const recover = 1 - Math.exp(-1 / (this.release * this.sampleRate));
    const delayLen = this.latency;
    let hist = this.hist, head = this.head, count = this.count, n = this.n, sum = this.sum, sinceSum = this.sinceSum, at = this.at;
    let envelope = this.envelope, gain = this.gain;
    let ceiling = c[0];
    for (let i = 0; i < frames; i++) {
      if (ceilingVaries) ceiling = c[i];
      const l = inL[i], r = inR[i];
      // 1. the true peak between the two samples GROUP frames back
      histL[hist] = l; histL[hist + TAPS] = l;
      histR[hist] = r; histR[hist + TAPS] = r;
      if (++hist === TAPS) hist = 0;
      const o = hist;   // the window [o, o + TAPS) is the last TAPS samples, oldest first
      let pl = histL[o + GROUP - 1], pr = histR[o + GROUP - 1];
      if (pl < 0) pl = -pl; if (pr < 0) pr = -pr;
      let peak = pl > pr ? pl : pr;
      let y1 = 0, y2 = 0, y3 = 0, z1 = 0, z2 = 0, z3 = 0;
      for (let t = 0; t < TAPS; t++) {
        const a = histL[o + t], b = histR[o + t];
        y1 += k1[t] * a; y2 += k2[t] * a; y3 += k3[t] * a;
        z1 += k1[t] * b; z2 += k2[t] * b; z3 += k3[t] * b;
      }
      if (y1 < 0) y1 = -y1; if (y2 < 0) y2 = -y2; if (y3 < 0) y3 = -y3;
      if (z1 < 0) z1 = -z1; if (z2 < 0) z2 = -z2; if (z3 < 0) z3 = -z3;
      if (y1 > peak) peak = y1; if (y2 > peak) peak = y2; if (y3 > peak) peak = y3;
      if (z1 > peak) peak = z1; if (z2 > peak) peak = z2; if (z3 > peak) peak = z3;
      // 2. the gain it needs, and the envelope that recovers over Release
      const required = peak > ceiling * MARGIN ? (ceiling * MARGIN) / peak : 1;
      envelope += (1 - envelope) * recover;
      if (envelope > 1 - 1e-12) envelope = 1;
      if (required < envelope) envelope = required;
      // 3. the running minimum over the window (a monotonic queue)
      const slot = n % window;
      need[slot] = envelope;
      while (count > 0 && need[queue[(head + count - 1) % (window + 1)] % window] >= envelope) count--;
      queue[(head + count) % (window + 1)] = n;
      count++;
      if (queue[head] <= n - window) { head = (head + 1) % (window + 1); count--; }
      const min = need[queue[head] % window];
      // 4. the running average over the box
      const boxSlot = n % box;
      sum += min - mins[boxSlot];
      mins[boxSlot] = min;
      if (++sinceSum === box) { sum = 0; for (let j = 0; j < box; j++) sum += mins[j]; sinceSum = 0; }
      gain = sum / box;
      if (gain > 1) gain = 1;
      n++;
      // 5. applied to the signal delayed to meet it
      const dl = delayL[at], dr = delayR[at];
      delayL[at] = l; delayR[at] = r;
      if (++at === delayLen) at = 0;
      outL[i] = dl * gain;
      outR[i] = dr * gain;
    }
    this.hist = hist; this.head = head; this.count = count; this.n = n; this.sum = sum; this.sinceSum = sinceSum; this.at = at;
    this.envelope = envelope; this.gain = gain;
  }

  reset() {
    this.histL.fill(0); this.histR.fill(0); this.hist = 0;
    this.need.fill(1); this.queue.fill(0); this.head = 0; this.count = 0; this.n = 0;
    this.mins.fill(1); this.sum = this.box; this.sinceSum = 0;
    this.delayL.fill(0); this.delayR.fill(0); this.at = 0;
    this.envelope = 1; this.gain = 1;
    this.ceiling.snap();
  }
}
