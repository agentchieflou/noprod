// Physical models (#77): digital waveguides, sample by sample.
//
//   player input → exciter ⇄ resonator → radiators → (the layer's filters…)
//
// The resonator is a delay loop as long as one vibration: a string (two
// delay lines either side of where it's bowed or plucked) or an air column
// (one line, its far end reflecting). Each sample, the exciter sees the wave
// coming back to it and adds its own: a bow's stick-slip friction, lips
// buzzing against the air in the mouthpiece, an air jet splitting at an
// edge, a reed opening and closing; or, open loop, a pluck or a strike.
// Loop lengths are corrected for the phase delay of the filters in the loop,
// so notes play in tune. Every loop gain is below 1.

import { estimatePitch } from './analysis.ts';
import { StateVariableFilter, createRandom } from './dsp.ts';
import type { Exciter, ModelLayer, Radiator, StringResonator, StringSet } from './types.ts';

// --------------------------------------------------------------- pieces

// A delay line read at a fractional, moving delay (linear interpolation).
// Reading before writing, each tick, makes the loop delay exactly `delay`.
class Delay {
  private readonly buffer: Float64Array;
  private readonly mask: number;
  private at = 0;

  constructor(longest: number) {
    let size = 16;
    while (size < longest + 4) size *= 2;
    this.buffer = new Float64Array(size);
    this.mask = size - 1;
  }

  read(delay: number) {
    const d = Math.min(Math.max(delay, 1), this.mask - 2);
    const p = this.at - d;
    const i = Math.floor(p);
    const a = this.buffer[i & this.mask];
    return a + (this.buffer[(i + 1) & this.mask] - a) * (p - i);
  }

  write(x: number) {
    this.buffer[this.at & this.mask] = x;
    this.at++;
  }
}

// y = g·(1 − a)·x + a·y⁻¹: the image's H(z) = (1 − a)/(1 − a·z⁻¹), with a gain
class OnePole {
  private y = 0;
  a: number;
  g: number;
  constructor(a: number, g = 1) { this.a = a; this.g = g; }
  tick(x: number) { this.y = this.g * (1 - this.a) * x + this.a * this.y; return this.y; }
  // its magnitude and phase delay (samples) at ω radians per sample
  magnitude(w: number) { return (this.g * (1 - this.a)) / Math.hypot(1 - this.a * Math.cos(w), this.a * Math.sin(w)); }
  phaseDelay(w: number) { return Math.atan2(this.a * Math.sin(w), 1 - this.a * Math.cos(w)) / w; }
}

// First-order allpass: frequency-dependent delay (string stiffness)
class Allpass {
  private x1 = 0;
  private y1 = 0;
  c: number;
  constructor(c: number) { this.c = c; }
  tick(x: number) { const y = this.c * x + this.x1 - this.c * this.y1; this.x1 = x; this.y1 = y; return y; }
  phaseDelay(w: number) {
    const phase = Math.atan2(-Math.sin(w), this.c + Math.cos(w)) - Math.atan2(-this.c * Math.sin(w), 1 + this.c * Math.cos(w));
    return -phase / w;
  }
}

class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private readonly r: number;
  constructor(sampleRate: number, hz = 12) { this.r = 1 - (2 * Math.PI * hz) / sampleRate; }
  tick(x: number) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
  // negative: it leads, more so at low frequencies
  phaseDelay(w: number) {
    const phase = Math.atan2(Math.sin(w), 1 - Math.cos(w)) - Math.atan2(this.r * Math.sin(w), 1 - this.r * Math.cos(w));
    return -phase / w;
  }
}

// Two poles at radius r: the lips, a mass on a spring. Its gain is set so a
// steady pressure holds them open by `rest` (they still respond far more
// strongly at their resonance), the same at every pitch.
class Lips {
  private y1 = 0;
  private y2 = 0;
  private a1 = 0;
  private a2 = 0;
  private b0 = 0;
  set(hz: number, r: number, rest: number, sampleRate: number) {
    this.a1 = -2 * r * Math.cos((2 * Math.PI * hz) / sampleRate);
    this.a2 = r * r;
    this.b0 = rest * (1 + this.a1 + this.a2);
  }
  tick(x: number) {
    const y = this.b0 * x - this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// The player's ear. A bowed or blown loop doesn't settle exactly on its
// note: the bow, lips, jet or reed pull it, more or less as it grows louder.
// A player hears this and lips or blows the note back into tune; so does
// this. Once a period it finds the lag at which the sound best repeats,
// near the period it should have, and nudges the loop's length toward it.
class Ear {
  // kept twice over, so a stretch of it reads without wrapping around
  private readonly history: Float64Array;
  private readonly size: number;
  private written = 0;
  private due = 0;
  private lag = 0;
  correction = 1;
  constructor(sampleRate: number, lowestHz: number) {
    this.size = Math.ceil((5.5 * sampleRate) / (lowestHz / 1.1)) + 4;
    this.history = new Float64Array(2 * this.size);
  }
  // Hears one sample `x` of a note meant to repeat every `period` samples
  hear(x: number, period: number) {
    const w = this.written % this.size;
    this.history[w] = this.history[w + this.size] = x;
    this.written++;
    if (--this.due > 0) return;
    this.due = Math.max(1, Math.round(period));
    const window = Math.round(2 * period);
    const lo = Math.floor(period / 1.1), hi = Math.ceil(period * 1.1);
    if (this.written < window + hi + 2) return;
    const now = w + this.size;
    // downhill from where it last heard the note repeat: the nearest repeat
    // is the note's, and a few steps cost far less than searching the range
    let best = this.lag > lo && this.lag < hi ? this.lag : Math.round(period);
    let here = this.unlike(now, window, best), before = this.unlike(now, window, best - 1), after = this.unlike(now, window, best + 1);
    if (before < here) {
      while (before < here && best > lo) { after = here; here = before; best--; before = this.unlike(now, window, best - 1); }
    } else {
      while (after < here && best < hi) { before = here; here = after; best++; after = this.unlike(now, window, best + 1); }
    }
    // only a clear repeat counts (not the noise of the attack), and only a
    // real minimum, not the edge of the range searched
    if (here > 0.1 || best <= lo || best >= hi) return;
    this.lag = best;
    const bend = before - 2 * here + after;
    const heard = best + (bend > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / bend)) : 0);
    // a share of the error each period: quick, but slower than the loop answers
    this.correction *= Math.pow(heard / period, 0.75);
    this.correction = Math.min(1.06, Math.max(1 / 1.06, this.correction));
  }

  // How unlike itself the sound is over the last `window` samples, `lag`
  // samples apart (0: a perfect repeat)
  private unlike(now: number, window: number, lag: number) {
    const h = this.history;
    let diff = 0, energy = 0;
    for (let j = now - window + 1; j <= now; j++) {
      const a = h[j], b = h[j - lag];
      diff += (a - b) * (a - b);
      energy += a * a + b * b;
    }
    return energy > 0 ? diff / energy : 1;
  }
}

// A safety net inside the loops: linear in normal use, bounded if a model runs away
const softClip = (x: number) => (Math.abs(x) < 4 ? x : Math.sign(x) * (4 + Math.tanh(Math.abs(x) - 4)));

// A stiff string's partials run sharp: f_k = k·f·√(1 + B·k²). Allpasses in
// the loop delay low frequencies more than high ones; find the coefficient
// that stretches the 12th partial as B says, for this note
const STIFF_SECTIONS = 4;
const stiffnessCache = new Map<string, number>();

function stiffnessCoefficient(hz: number, inharmonicity: number, sr: number) {
  const key = `${hz.toFixed(3)}|${inharmonicity}|${sr}`;
  const cached = stiffnessCache.get(key);
  if (cached !== undefined) return cached;
  const probe = new Allpass(0);
  const delayOf = (c: number, w: number) => { probe.c = c; return probe.phaseDelay(w); };
  const stretch = (c: number) => {
    const w1 = (2 * Math.PI * hz) / sr;
    const n = sr / hz - STIFF_SECTIONS * delayOf(c, w1);
    let f = 12 * hz;
    for (let i = 0; i < 40; i++) f = (12 * sr) / (n + STIFF_SECTIONS * delayOf(c, (2 * Math.PI * Math.min(f, sr * 0.45)) / sr));
    return f / (12 * hz);
  };
  const target = Math.sqrt(1 + 144 * inharmonicity);
  let lo = -0.95, hi = 0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (stretch(mid) > target) lo = mid; else hi = mid;
  }
  const c = (lo + hi) / 2;
  stiffnessCache.set(key, c);
  return c;
}

// --------------------------------------------------------------- exciters

interface Excitation {
  closed: boolean;   // reads the resonator's returning wave
  sign: number;      // -1 if its junction inverts the wave (the jet)
  bore: number;      // a bore's length in periods: lips play its 2nd resonance, a jet overblows
  // what it adds at the junction, given the returning wave, the player's
  // input (0..1) and the current period in samples
  tick(incoming: number, input: number, period: number): number;
}

interface Context {
  sampleRate: number;
  velocity: number;
  baseHz: number;
  random: () => number;
}

export const closedLoop = (exciter: Exciter) => exciter.kind !== 'pluck' && exciter.kind !== 'strike';

function excitation(exciter: Exciter, ctx: Context): Excitation {
  const { sampleRate: sr, velocity, random } = ctx;
  switch (exciter.kind) {
    case 'pluck': {
      // One period of noise (Karplus–Strong), softened for a soft finger
      const hardness = exciter.hardness ?? 0.6;
      const burst = new Float64Array(Math.max(2, Math.round(sr / ctx.baseHz)));
      const a = 0.92 - 0.9 * hardness;
      const soften = new OnePole(a);
      for (let i = 0; i < burst.length; i++) burst[i] = soften.tick(random() * 2 - 1);
      let mean = 0, power = 0;
      for (const x of burst) mean += x / burst.length;
      for (const x of burst) power += (x - mean) ** 2 / burst.length;
      // at the level the softened noise has, however short the period (a
      // short burst of dark noise is mostly its mean, taken out above)
      const scale = power > 0 ? Math.sqrt((1 - a) / (3 * (1 + a)) / power) : 0;
      const amount = (0.4 + 0.6 * velocity) * scale;
      let n = 0;
      return { closed: false, sign: 1, bore: 1, tick: () => (n < burst.length ? (burst[n++] - mean) * amount : 0) };
    }
    case 'strike': {
      // A raised-cosine push: a hard mallet is brief, a felt hammer longer
      const hardness = exciter.hardness ?? 0.5;
      const width = Math.max(2, Math.round(sr * (0.004 - 0.0034 * hardness)));
      const amount = 0.4 + 0.6 * velocity;
      let n = 0;
      return { closed: false, sign: 1, bore: 1, tick: () => (n < width ? amount * 0.5 * (1 - Math.cos((2 * Math.PI * n++) / width)) : 0) };
    }
    case 'bow': {
      // Stick-slip friction: the bow drags the string until it slips
      const slope = 5 - 4 * (exciter.pressure ?? 0.5);
      const top = 0.03 + 0.2 * velocity;
      const noise = exciter.noise ?? 0.1;
      return {
        closed: true, sign: 1, bore: 1,
        tick: (incoming, input) => {
          if (input <= 0) return 0;
          const bow = top * input * (1 + noise * 0.2 * (random() * 2 - 1));
          const dv = bow - incoming;
          const friction = Math.min(1, Math.pow(Math.abs(dv * slope) + 0.75, -4));
          return dv * friction;
        }
      };
    }
    case 'lips': {
      // Lips as a mass on a spring, tuned near the note, opening with the
      // pressure difference; the flow through them saturates
      const lips = new Lips();
      const tension = exciter.tension ?? 1;
      let tuned = 0;
      const top = 0.6 + 0.4 * velocity;
      return {
        closed: true, sign: 1, bore: 2,
        tick: (incoming, input, period) => {
          const hz = (sr / period) * tension;
          // the lips' bandwidth is a fixed share of the note, so low notes still pick out their bore resonance;
          // they sit a little below the note, and aren't driven so hard that
          // they flutter (two frequencies at once, neither the note)
          if (Math.abs(hz - tuned) > 0.01) { lips.set(hz * 0.97, 1 - (Math.PI * 0.15 * hz) / sr, 1.2, sr); tuned = hz; }
          const mouth = 0.3 * top * input;
          let open = lips.tick(mouth - incoming);
          open *= open;
          if (open > 1) open = 1;
          return open * (mouth - incoming);
        }
      };
    }
    case 'jet': {
      // Breath across an edge: the jet takes a while to cross, then splits
      // (a cubic nonlinearity) into or out of the pipe
      const jet = new Delay(Math.ceil(sr / 15));
      const ratio = exciter.ratio ?? 0.34;
      const noise = exciter.noise ?? 0.15;
      const top = 0.75 + 0.25 * velocity;
      // The jet sits at a fixed point on the curve and the breath sets how
      // hard it blows. (Were the breath to move that point, the jet's gain
      // would pass through zero as a note starts, and the note would start
      // on the wrong resonance.)
      const bias = 1;
      const rest = bias * (bias * bias - 1);
      return {
        closed: true, sign: -1, bore: 1.5,
        tick: (incoming, input, period) => {
          jet.write(0.2 * noise * input * (random() * 2 - 1) - 0.5 * incoming);
          const x = bias + jet.read(period * 1.5 * ratio);
          const split = top * input * (Math.max(-1, Math.min(1, x * (x * x - 1))) - rest);
          // The mouth is an open end: it reflects most of the wave, less while
          // the jet blows across it and sheds the wave's energy as eddies. So
          // the pipe rings on for a moment when the breath stops
          return split + (0.85 - 0.35 * Math.min(1, input)) * incoming - incoming;
        }
      };
    }
    case 'reed': {
      // A reed: the pressure difference across it closes it, slope sets its stiffness
      const slope = -0.44 + 0.26 * (exciter.stiffness ?? 0.5);
      const noise = exciter.noise ?? 0.05;
      const top = 0.55 + 0.4 * velocity;
      return {
        closed: true, sign: 1, bore: 1,
        tick: (incoming, input) => {
          if (input <= 0) return 0;
          const breath = top * input * (1 + noise * (random() * 2 - 1));
          const difference = incoming - breath;
          const opening = Math.max(-1, Math.min(1, 0.7 + slope * difference));
          return breath + difference * opening - incoming;
        }
      };
    }
  }
}

// ------------------------------------------------------------- resonators

interface Resonance_ {
  // the wave arriving where the exciter is, then what the exciter adds; the
  // second returns the sample heard (at the bridge, or the bell). `damp`
  // takes from the played strings' energy each time round (their damper)
  incoming(hz: number, damp?: number): number;
  inject(e: number): number;
  tail: number;  // seconds it rings after the excitation stops
}

// A string: two lines either side of the exciter; rigid at the nut, and
// at the bridge whatever the bridge sends back
class StringLoop {
  private readonly neck: Delay;
  private readonly bridge: Delay;
  private readonly loss: OnePole;
  private readonly allpasses: Allpass[];
  private readonly beta: number;
  private readonly decay: number;
  private readonly buzz: number;
  private readonly sr: number;
  private toNeck = 0;
  private toBridge = 0;
  private tuned = 0;
  private dBridge = 0;
  private dNeck = 0;
  private period = 0;
  private settle = 0;
  private swing = 0;
  heard = 0;

  constructor(string: { decay?: number; brightness?: number; stiffness?: number; buzz?: number }, position: number, sr: number, lowestHz: number) {
    this.decay = string.decay ?? 3;
    this.loss = new OnePole(0.05 + 0.75 * (1 - (string.brightness ?? 0.5)));
    const stiffness = string.stiffness ?? 0;
    const c = stiffness > 0 ? stiffnessCoefficient(lowestHz, stiffness * 0.0012, sr) : 0;
    this.allpasses = c ? Array.from({ length: STIFF_SECTIONS }, () => new Allpass(c)) : [];
    const longest = sr / Math.max(10, lowestHz) + 8;
    this.neck = new Delay(longest);
    this.bridge = new Delay(longest);
    this.beta = Math.min(0.5, Math.max(0.02, position));
    this.buzz = string.buzz ?? 0;
    this.sr = sr;
  }

  // The wave arriving at the bridge, past the string's losses
  arrive(hz: number) {
    const sr = this.sr;
    if (Math.abs(hz - this.tuned) > 1e-3) {
      const w = (2 * Math.PI * hz) / sr;
      const period = sr / hz;
      // the fundamental falls 60 dB in `decay` seconds, whatever the filter does to it
      this.loss.g = 1;
      this.loss.g = Math.min(0.99999, Math.pow(10, -3 / (this.decay * hz)) / this.loss.magnitude(w));
      let stretch = 0;
      for (let k = 0; k < this.allpasses.length; k++) stretch += this.allpasses[k].phaseDelay(w);
      const delay = Math.max(2, period - this.loss.phaseDelay(w) - stretch);
      this.dBridge = delay * this.beta;
      this.dNeck = delay - this.dBridge;
      this.period = period;
      this.settle = Math.exp(-1 / (2 * period));
      this.tuned = hz;
    }
    // A curved bridge (a sitar's jawari): on one side of each swing the
    // string lies along it, and is shorter while it does, the more so the
    // wider it swings. Its wave folds there once a period: it buzzes, and
    // fills in the harmonics where it was plucked left gaps
    let onto = 0;
    if (this.buzz > 0) {
      this.swing = Math.max(Math.abs(this.heard), this.swing * this.settle);
      if (this.heard > 0) onto = this.buzz * 0.03 * this.period * Math.min(1, 4 * this.swing) * (this.heard / this.swing);
    }
    this.heard = this.bridge.read(this.dBridge - onto);
    let back = this.loss.tick(this.heard);
    for (let k = 0; k < this.allpasses.length; k++) back = this.allpasses[k].tick(back);
    this.toBridge = -this.neck.read(this.dNeck);   // reflected at the nut
    return back;
  }

  // Sends `wave` back from the bridge; returns the string's velocity under the exciter
  leave(wave: number) {
    this.toNeck = wave;
    return this.toNeck + this.toBridge;
  }

  inject(e: number) {
    this.neck.write(softClip(this.toNeck + e));
    this.bridge.write(softClip(this.toBridge + e));
  }
}

// The strings a layer has at its bridge besides its own (none if its
// resonator isn't a string, or is switched off)
export const stringSets = (layer: ModelLayer, off: Set<string>): StringSet[] =>
  layer.resonator.kind !== 'string' || off.has('resonator') ? []
    : (layer.strings ?? []).filter((set, k) => !off.has(`strings:${k}`) && (set.notes ?? set.cents ?? [0]).length > 0);

// A string nothing plays: one loop, from the bridge to the nut and back
class FreeString {
  private readonly line: Delay;
  private readonly loss: OnePole;
  private readonly decay: number;
  private readonly sr: number;
  private tuned = 0;
  private delay = 0;
  heard = 0;

  constructor(decay: number, brightness: number, sr: number, hz: number) {
    this.decay = decay;
    this.loss = new OnePole(0.05 + 0.75 * (1 - brightness));
    this.line = new Delay(sr / Math.max(10, hz) + 8);
    this.sr = sr;
  }

  arrive(hz: number) {
    if (Math.abs(hz - this.tuned) > 1e-3) {
      const w = (2 * Math.PI * hz) / this.sr;
      this.loss.g = 1;
      this.loss.g = Math.min(0.99999, Math.pow(10, -3 / (this.decay * hz)) / this.loss.magnitude(w));
      this.delay = Math.max(2, this.sr / hz - this.loss.phaseDelay(w));
      this.tuned = hz;
    }
    this.heard = -this.line.read(this.delay);   // reflected at the nut
    return this.loss.tick(this.heard);
  }

  leave(wave: number) {
    this.line.write(softClip(wave));
  }
}

// Strings at one bridge. Each string's wave arrives there, and the bridge,
// pushed by all of them, moves: it sends every string's wave back inverted
// (as a rigid bridge would) plus its own motion, which carries each string's
// vibration into the others. For N strings of impedance R on a bridge of
// impedance R_b, the bridge moves at J = α·Σ u (u: the arriving waves) with
// α = 2R/(N·R + R_b), and string i gets J − u_i back: the scattering matrix
// S = α·11ᵀ − I. S is symmetric, with eigenvalues −1 (the strings moving
// against each other, which leave the bridge still) and α·N − 1 (all of them
// together, which move it). So |S| ≤ 1, and no energy is made, as long as
// 0 ≤ α·N ≤ 2; and α·N = 2Nρ/(1 + Nρ) < 2 for any ρ = R/R_b ≥ 0. The bridge
// gives more to low frequencies than high: α is a one-pole low-pass,
// α(ω)·N, whose values lie on a circle from α·N at DC to less above it,
// inside the disc |z − 1| ≤ 1 whenever α·N ≤ 2. The strings moving together
// lose to the bridge what they give it: the in-phase motion dies first, then
// what's left of the strings' differences rings on (a piano's two-stage decay).
const BRIDGE_CUTOFF = 2500;

function bridged(resonator: StringResonator, sets: StringSet[], position: number, sr: number, lowestHz: number): Resonance_ {
  const main = new StringLoop(resonator, position, sr, lowestHz);
  const decay = resonator.decay ?? 3;
  // a unison course is played with the string; sympathetic strings aren't touched
  const course: { string: StringLoop; ratio: number; hz: number }[] = [];
  const free: { string: FreeString; ratio: number; hz: number; level: number }[] = [];
  for (const set of sets) {
    const tunings = set.notes ? set.notes.map((n) => ({ ratio: 0, hz: 440 * Math.pow(2, (n - 69) / 12) }))
      : (set.cents ?? [0]).map((c) => ({ ratio: Math.pow(2, c / 1200), hz: 0 }));
    for (const { ratio, hz } of tunings) {
      const lowest = ratio ? lowestHz * ratio : hz;
      if (set.kind === 'unison') {
        course.push({ string: new StringLoop({ ...resonator, decay: set.decay ?? decay, brightness: set.brightness ?? resonator.brightness, buzz: 0 }, position, sr, lowest), ratio, hz });
      } else {
        free.push({ string: new FreeString(set.decay ?? decay, set.brightness ?? resonator.brightness ?? 0.5, sr, lowest), ratio, hz, level: set.level ?? 1 });
      }
    }
  }
  const n = 1 + course.length + free.length;
  const rho = 0.004 * Math.min(1, Math.max(0, resonator.coupling ?? 0.3));
  const alpha = (2 * rho) / (1 + n * rho);
  const motion = new OnePole(Math.exp((-2 * Math.PI * BRIDGE_CUTOFF) / sr));
  const fromCourse = new Float64Array(course.length);
  const fromFree = new Float64Array(free.length);
  return {
    tail: Math.max(decay, ...sets.map((set) => set.decay ?? decay)),
    incoming(hz, damp = 1) {
      const u = main.arrive(hz);
      let sum = u;
      for (let k = 0; k < course.length; k++) sum += (fromCourse[k] = course[k].string.arrive(course[k].ratio ? hz * course[k].ratio : course[k].hz));
      for (let k = 0; k < free.length; k++) sum += (fromFree[k] = free[k].string.arrive(free[k].ratio ? hz * free[k].ratio : free[k].hz));
      const bridge = alpha * motion.tick(sum);
      // the played strings are damped together; the sympathetic ones ring on
      for (let k = 0; k < course.length; k++) course[k].string.leave((bridge - fromCourse[k]) * damp);
      for (let k = 0; k < free.length; k++) free[k].string.leave(bridge - fromFree[k]);
      return main.leave((bridge - u) * damp);
    },
    inject(e) {
      main.inject(e);
      let played = main.heard;
      for (let k = 0; k < course.length; k++) {
        course[k].string.inject(e);
        played += course[k].string.heard;
      }
      let sympathetic = 0;
      for (let k = 0; k < free.length; k++) sympathetic += free[k].level * free[k].string.heard;
      // what the bridge passes to the body: the course (as loud together as
      // one string) and the sympathetic strings with it
      return played / (1 + course.length) + sympathetic;
    }
  };
}

function resonator(layer: ModelLayer, excite: Excitation, position: number, sr: number, lowestHz: number, off: Set<string>): Resonance_ {
  const resonator = layer.resonator;
  if (resonator.kind === 'string') {
    const sets = stringSets(layer, off);
    if (sets.length) return bridged(resonator, sets, position, sr, lowestHz);
    const string = new StringLoop(resonator, position, sr, lowestHz);
    return {
      tail: resonator.decay ?? 3,
      incoming(hz) {
        const back = string.arrive(hz);
        return string.leave(-back);     // reflected at the bridge
      },
      inject(e) {
        string.inject(e);
        return string.heard;
      }
    };
  }

  // A bore: one line, the round trip to the far end and back
  const end = resonator.end ?? 'open';
  const reflect = end === 'open' ? -1 : 1;
  const lossAmount = resonator.loss ?? 0.5;
  const loss = new OnePole(0.3 + 0.6 * lossAmount, 0.995 - 0.15 * lossAmount);
  // With the exciter's own inversion the loop either keeps the wave's sign
  // (every harmonic: a period long) or flips it (odd harmonics: half a period)
  const flips = reflect * excite.sign < 0;
  const periods = excite.bore * (flips ? 0.5 : 1);
  // The wave passes this every trip. A loop that keeps the sign would hold
  // DC, so it needs one; a loop that flips can't, and there it sits low, so
  // that a low note's fundamental doesn't die before its harmonics
  const dc = new DcBlocker(sr, flips ? 2 : 12);
  const line = new Delay((2 * sr) / Math.max(10, lowestHz) + 8);
  let back = 0, heard = 0, tuned = 0, delay = 0;
  return {
    tail: 0.25,
    incoming(hz) {
      if (Math.abs(hz - tuned) > 1e-3) {
        const w = (2 * Math.PI * hz) / sr;
        delay = Math.max(2, (sr / hz) * periods - loss.phaseDelay(w) - dc.phaseDelay(w));
        tuned = hz;
      }
      heard = line.read(delay);
      back = dc.tick(reflect * loss.tick(heard));
      return back;
    },
    inject(e) {
      line.write(softClip(back + e));
      return heard;
    }
  };
}

// -------------------------------------------------------------- radiators

const BODIES: Record<string, { hz: number; q: number; gain: number }[]> = {
  // A violin's air (A0), its main wood modes (B1−, B1+) and the bridge hill
  violin: [{ hz: 275, q: 12, gain: 1 }, { hz: 460, q: 10, gain: 0.9 }, { hz: 550, q: 10, gain: 0.8 }, { hz: 1000, q: 6, gain: 0.4 }, { hz: 2500, q: 3, gain: 0.7 }, { hz: 3600, q: 5, gain: 0.3 }],
  cello: [{ hz: 100, q: 10, gain: 1 }, { hz: 180, q: 8, gain: 0.9 }, { hz: 220, q: 8, gain: 0.8 }, { hz: 450, q: 6, gain: 0.5 }, { hz: 1100, q: 3, gain: 0.5 }, { hz: 2000, q: 4, gain: 0.3 }],
  // A guitar's Helmholtz air mode and top-plate modes
  guitar: [{ hz: 100, q: 9, gain: 1 }, { hz: 200, q: 12, gain: 0.8 }, { hz: 390, q: 10, gain: 0.5 }, { hz: 600, q: 8, gain: 0.35 }, { hz: 1000, q: 5, gain: 0.25 }],
  harp: [{ hz: 160, q: 4, gain: 0.8 }, { hz: 340, q: 5, gain: 0.7 }, { hz: 700, q: 4, gain: 0.4 }, { hz: 1500, q: 3, gain: 0.3 }],
  box: [{ hz: 220, q: 6, gain: 1 }, { hz: 530, q: 6, gain: 0.6 }, { hz: 1300, q: 5, gain: 0.4 }]
};

// One radiator, a sample at a time
interface Radiating { tick(x: number): number }

function radiator(radiator: Radiator, sr: number, noteHz: number): Radiating {
  switch (radiator.kind) {
    case 'body': {
      const modes = radiator.modes ?? BODIES[radiator.preset ?? 'box'];
      const mix = radiator.mix ?? 0.7;
      const filters = modes.map((m) => { const f = new StateVariableFilter('bandpass'); f.set(m.hz, m.q, sr); return f; });
      const gains = modes.map((m) => m.gain);
      const norm = 1 / Math.max(1, Math.sqrt(modes.reduce((s, m) => s + m.gain * m.gain, 0)));
      return {
        tick(x) {
          let body = 0;
          for (let k = 0; k < filters.length; k++) body += gains[k] * filters[k].process(x);
          return (1 - mix) * x + mix * body * norm * 2;
        }
      };
    }
    case 'helmholtz': {
      const f = new StateVariableFilter('bandpass');
      f.set(radiator.hz ?? 110, radiator.q ?? 6, sr);
      const mix = radiator.mix ?? 0.4;
      return { tick: (x) => x + mix * 2 * f.process(x) };
    }
    case 'bell': {
      const f = new StateVariableFilter('highpass');
      f.set(radiator.cutoff ?? 700, 0.6, sr);
      const mix = radiator.mix ?? 0.8;
      return { tick: (x) => (1 - mix) * x + mix * 1.5 * f.process(x) };
    }
    case 'tonehole': {
      const hp = new StateVariableFilter('highpass');
      hp.set(noteHz * (radiator.cutoff ?? 0.7), 0.7, sr);
      const lp = new OnePole(0.75 * (1 - (radiator.brightness ?? 0.6)));
      return { tick: (x) => lp.tick(hp.process(x)) };
    }
    case 'damping': {
      const lp = new OnePole(Math.min(0.99, Math.max(0, radiator.a ?? 0.5)));
      return { tick: (x) => lp.tick(x) };
    }
  }
}

// ----------------------------------------------------------------- render

export interface ModelRender {
  sampleRate: number;
  baseHz: number;
  velocity: number;
  seed: number;
  off: Set<string>;  // bypassed blocks
}

// How long the resonator rings once nothing excites it (its longest string)
export const modelTail = (layer: ModelLayer) => {
  if (layer.resonator.kind !== 'string') return 0.25;
  const decay = layer.resonator.decay ?? 3;
  return Math.min(10, Math.max(decay, ...stringSets(layer, new Set(layer.bypass)).map((set) => set.decay ?? decay)));
};

// Closed-loop models settle a little off the loop's pitch (the lips, the
// jet and the reed have dynamics of their own), so each note is tuned like an
// instrument: a short probe is played, its pitch measured, and the model
// retuned by the difference (three times, to converge). Cached per
// configuration. (A live note gets it from here, off the audio thread.)
const tunings = new Map<string, number>();
const PROBE = 0.7;

export function modelTuning(layer: ModelLayer, r: ModelRender): number {
  const key = `${JSON.stringify([layer.exciter, layer.resonator, stringSets(layer, r.off)])}|${r.baseHz.toFixed(4)}|${r.velocity.toFixed(3)}|${r.sampleRate}`;
  const cached = tunings.get(key);
  if (cached !== undefined) return cached;
  const n = Math.round(PROBE * r.sampleRate);
  const probe = new Float32Array(n);
  let correction = 1;
  for (let pass = 0; pass < 3; pass++) {
    const loop = new ModelLoop(layer, r, correction, 1, false);
    for (let i = 0; i < n; i++) probe[i] = loop.tick(1, 1);
    const size = Math.min(4096, Math.floor(n / 2));
    const hz = estimatePitch(probe, r.sampleRate, n - size, size, r.baseHz / 1.6, r.baseHz * 1.6);
    if (!(hz > 0)) break;
    correction *= r.baseHz / hz;
    if (correction < 0.7 || correction > 1.4) { correction = 1; break; }
  }
  tunings.set(key, correction);
  return correction;
}

// Writes the model's sound into `out` (mono). `input` is the player's input
// over time (the layer's envelope), `bend` its frequency multiplier.
export function renderModel(layer: ModelLayer, r: ModelRender, input: Float32Array, bend: Float64Array | null, out: Float32Array) {
  if (r.off.has('exciter')) return;
  const tuned = closedLoop(layer.exciter) && !r.off.has('resonator');
  let lowest = 1;
  if (bend) for (let i = 0; i < bend.length; i++) lowest = Math.min(lowest, bend[i]);
  const voice = new ModelVoice(layer, r, tuned ? modelTuning(layer, r) : 1, lowest, tuned);
  for (let i = 0; i < out.length; i++) out[i] = voice.tick(input[i] ?? 0, bend ? bend[i] : 1);
}

// ----------------------------------------------------------------- voices

// One note of a model layer, a sample at a time (#106): the exciter in its
// resonator, then the radiators. A rendered note runs one to its end; a
// live note runs one block by block, for as long as it's held. Making one
// allocates (do it outside the audio callback); `tick` doesn't.
//
//   tune        the closed loop's tuning, from `modelTuning` (1: none)
//   lowestBend  the lowest the note will bend to (sizes its delay lines)
//   listen      tuned by ear as it plays (the closed loops)
//
// Each `tick` returns what a rendered note's buffer holds: the stages meet in
// 32-bit floats, as the buffers between them did, so a voice and a
// rendered note agree to the bit.
export class ModelVoice {
  private readonly loop: ModelLoop | null;
  private readonly series: Radiating[];
  private readonly parallel: Radiating[];
  private readonly dc: DcBlocker;

  constructor(layer: ModelLayer, r: ModelRender, tune: number, lowestBend = 1, listen = false) {
    this.loop = r.off.has('exciter') ? null : new ModelLoop(layer, r, tune, lowestBend, listen);
    const radiators = (list: Radiator[] | undefined, id: string) => (list ?? [])
      .map((x, k) => (r.off.has(`${id}:${k}`) ? null : radiator(x, r.sampleRate, r.baseHz)))
      .filter((x): x is Radiating => x !== null);
    this.series = radiators(layer.radiators, 'radiator');
    // each parallel radiator takes the resonator's sound as it is, before the series ones
    this.parallel = radiators(layer.parallel, 'parallel');
    this.dc = new DcBlocker(r.sampleRate);
  }

  // One sample, given the player's input (0..1) and the frequency multiplier
  tick(input: number, bend: number) {
    if (!this.loop) return 0;
    const dry = Math.fround(this.loop.tick(input, bend));
    let y = dry;
    for (let k = 0; k < this.series.length; k++) y = Math.fround(this.series[k].tick(y));
    if (this.parallel.length) {
      for (let k = 0; k < this.parallel.length; k++) y = Math.fround(y + Math.fround(this.parallel[k].tick(dry)));
      // the paths mixed, as loud together as one
      y = Math.fround(y / (1 + this.parallel.length));
    }
    // what radiates carries no DC (the lips' and reed's steady flow stays in the instrument)
    return Math.fround(this.dc.tick(y));
  }
}

// The exciter in its resonator, a sample at a time
class ModelLoop {
  private readonly sr: number;
  private readonly baseHz: number;
  private readonly noteHz: number;
  private readonly excite: Excitation;
  private readonly ring: Resonance_ | null;
  private readonly ear: Ear | null;
  // Plucked or struck strings at a shared bridge are damped in the loop, by
  // the envelope where it falls, so the sympathetic strings can ring on; it
  // looks back a period at what the player's input was
  private readonly inputs: Float32Array | null;
  private written = 0;

  constructor(layer: ModelLayer, r: ModelRender, tune: number, lowestBend: number, listen: boolean) {
    const sr = this.sr = r.sampleRate;
    this.noteHz = r.baseHz;
    const baseHz = this.baseHz = r.baseHz * tune;
    const random = createRandom(r.seed);
    this.excite = excitation(layer.exciter, { sampleRate: sr, velocity: r.velocity, baseHz, random });
    const position = layer.exciter.kind === 'pluck' ? layer.exciter.position ?? 0.2
      : layer.exciter.kind === 'strike' ? layer.exciter.position ?? 0.12
        : layer.exciter.kind === 'bow' ? layer.exciter.position ?? 0.13 : 0.5;
    const lowest = baseHz * lowestBend;
    this.ring = r.off.has('resonator') ? null : resonator(layer, this.excite, position, sr, lowest, r.off);
    this.inputs = !this.excite.closed && stringSets(layer, r.off).length > 0 ? new Float32Array(Math.ceil(sr / lowest) + 2) : null;
    this.ear = listen ? new Ear(sr, lowest) : null;
  }

  tick(input: number, bend: number) {
    const sr = this.sr;
    const hz = this.baseHz * bend;
    const period = sr / hz;
    if (!this.ring) return this.excite.tick(0, input, period);
    let damp = 1;
    if (this.inputs) {
      // what the envelope lost over one trip round the string (once it has
      // fallen silent, the damper stays on)
      const inputs = this.inputs, n = inputs.length;
      inputs[this.written % n] = input;
      const back = this.written - Math.round(period);
      const was = back >= 0 ? inputs[back % n] : 0, now = inputs[this.written % n];
      damp = was > 0 ? Math.min(1, now / was) : now > 0 ? 1 : 0;
      this.written++;
    }
    // retuned by ear: the player's lips or breath move with the loop, as an embouchure does
    const ear = this.ear;
    const heard = ear ? hz * ear.correction : hz;
    const back = this.ring.incoming(heard, damp);
    const out = this.ring.inject(this.excite.tick(back, input, sr / heard));
    if (ear) ear.hear(Math.fround(out), sr / (this.noteHz * bend));
    return out;
  }
}
