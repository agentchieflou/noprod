// NoProd Delay: a stereo feedback delay, as the native graph builds it
// from a DelayNode and a gain in a loop (the wet signal is the line's
// output, which also feeds back into it). The delay in frames is Time ×
// sampleRate: exact to the sample when that is whole, else read between
// two samples as DelayNode does. A Time set from a knob crossfades from
// the old tap to the new one over 10 ms, so it neither clicks nor
// glides; a Time lane ramps the tap per sample, which bends the pitch as
// an automated DelayNode does.

import { BLOCK, Mix, Smoothed, num, type DeviceKernel, type ParamValue } from './kernel.ts';

const MAX_TIME = 2;             // seconds, the ParamSpec's
const MIN_TIME = 0.01;
const XFADE = 0.01;             // seconds, from the old tap to the new
const QUIET = 1e-20;            // below this, what is written counts as nothing

export class Delay implements DeviceKernel {
  readonly kind = 'delay';
  readonly latency = 0;
  private readonly sampleRate: number;
  private readonly lineL: Float32Array;
  private readonly lineR: Float32Array;
  private readonly size: number;
  private write = 0;
  private tap = 0;              // frames, the current delay
  private oldTap = 0;           // the tap being faded out while `fade` > 0
  private fade = 0;             // samples of crossfade left
  private readonly fadeFrames: number;
  private time = 0.25;          // seconds, the setting
  private readonly feedback: Smoothed;
  private readonly mix: Mix;
  private quiet = 0;            // frames since something above QUIET was written
  private clean = true;         // the lines hold nothing
  private primed = false;
  private readonly w = new Float32Array(BLOCK);
  private readonly fb = new Float32Array(BLOCK);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.size = Math.ceil(MAX_TIME * sampleRate) + BLOCK + 2;
    this.lineL = new Float32Array(this.size);
    this.lineR = new Float32Array(this.size);
    this.fadeFrames = Math.round(XFADE * sampleRate);
    this.tap = this.oldTap = 0.25 * sampleRate;
    this.feedback = new Smoothed(0.4, sampleRate);
    this.mix = new Mix(30, sampleRate);
  }

  private frames(seconds: number) { return Math.max(MIN_TIME, Math.min(MAX_TIME, seconds)) * this.sampleRate; }

  // Repeats until the feedback has taken the signal to -60 dB, plus the delay itself
  tail() {
    const fb = Math.min(0.95, this.feedback.target);
    const repeats = fb > 0 ? Math.ceil(60 / (-20 * Math.log10(fb))) : 0;
    return Math.ceil(this.frames(this.time) * (repeats + 1));
  }

  set(name: string, value: ParamValue) {
    switch (name) {
      case 'Time': {
        const t = num(value, this.time);
        if (t === this.time) return;
        this.time = t;
        const tap = this.frames(t);
        if (!this.primed) { this.tap = this.oldTap = tap; return; }
        this.oldTap = this.tap;
        this.tap = tap;
        this.fade = this.fadeFrames;
        return;
      }
      case 'Feedback': this.feedback.set(Math.min(0.95, Math.max(0, num(value, 40) / 100))); break;
      case 'Dry/Wet': this.mix.set(num(value, 30)); break;
      default: return;
    }
    if (!this.primed) { this.feedback.snap(); this.mix.wet.snap(); }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number, ramps?: ReadonlyMap<string, [number, number]>) {
    this.primed = true;
    const { lineL, lineR, size, w, fb } = this;
    const mixVaries = this.mix.fill(w, frames, ramps?.get('Dry/Wet'));
    const rFb = ramps?.get('Feedback');
    let fbVaries = true;
    if (rFb) {
      const from = Math.min(0.95, Math.max(0, rFb[0] / 100)), to = Math.min(0.95, Math.max(0, rFb[1] / 100));
      const step = (to - from) / Math.max(1, frames - 1);
      for (let i = 0; i < frames; i++) fb[i] = from + step * i;
      this.feedback.value = this.feedback.target = to;
    } else if (this.feedback.moving) {
      const f = this.feedback;
      for (let i = 0; i < frames; i++) { f.tick(); fb[i] = f.value; }
    } else { fb[0] = this.feedback.value; fbVaries = false; }
    // The tap: a lane bends it per sample; a knob's change crossfades
    const rTime = ramps?.get('Time');
    let tap = this.tap, tapStep = 0;
    if (rTime) {
      const from = this.frames(rTime[0]), to = this.frames(rTime[1]);
      tap = from; tapStep = (to - from) / Math.max(1, frames - 1);
      this.time = rTime[1];
      this.fade = 0;
    }
    let write = this.write, fade = this.fade, quiet = this.quiet, clean = this.clean;
    const oldTap = this.oldTap, fadeFrames = this.fadeFrames;
    let wet = w[0], feedback = fb[0];
    for (let i = 0; i < frames; i++) {
      if (mixVaries) wet = w[i];
      if (fbVaries) feedback = fb[i];
      const xl = inL[i], xr = inR[i];
      // the tap's output, between two samples when the delay isn't whole
      const d = tap + tapStep * i;
      const whole = Math.floor(d), frac = d - whole;
      let a = write - whole; if (a < 0) a += size;
      let b = a - 1; if (b < 0) b += size;
      let yl = lineL[a] + (lineL[b] - lineL[a]) * frac;
      let yr = lineR[a] + (lineR[b] - lineR[a]) * frac;
      if (fade > 0) {
        // the old tap fades out over the crossfade
        const t = fade / fadeFrames;
        const ow = Math.floor(oldTap), of = oldTap - ow;
        let oa = write - ow; if (oa < 0) oa += size;
        let ob = oa - 1; if (ob < 0) ob += size;
        yl += ((lineL[oa] + (lineL[ob] - lineL[oa]) * of) - yl) * t;
        yr += ((lineR[oa] + (lineR[ob] - lineR[oa]) * of) - yr) * t;
        fade--;
      }
      const wl = xl + yl * feedback, wr = xr + yr * feedback;
      lineL[write] = wl; lineR[write] = wr;
      if (++write === size) write = 0;
      if (wl > QUIET || wl < -QUIET || wr > QUIET || wr < -QUIET) { quiet = 0; clean = false; } else quiet++;
      outL[i] = xl + (yl - xl) * wet;
      outR[i] = xr + (yr - xr) * wet;
    }
    if (rTime) tap += tapStep * (frames - 1);
    this.tap = tap; this.write = write; this.fade = fade; this.quiet = quiet;
    // Nothing but what counts as nothing has been written for as long as
    // the taps reach back: the lines are empty, so empty them for real
    // before what is left decays into the subnormal range
    if (!clean && quiet > Math.ceil(Math.max(tap, oldTap)) + 2) { lineL.fill(0); lineR.fill(0); clean = true; }
    this.clean = clean;
  }

  reset() {
    this.lineL.fill(0); this.lineR.fill(0);
    this.write = 0; this.fade = 0; this.quiet = 0; this.clean = true;
    this.oldTap = this.tap = this.frames(this.time);
    this.feedback.snap(); this.mix.wet.snap();
  }
}
