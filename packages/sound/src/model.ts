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
import type { Exciter, ModelLayer, Radiator, Resonator } from './types.ts';

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
  constructor(sampleRate: number) { this.r = 1 - (2 * Math.PI * 12) / sampleRate; }
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
      const soften = new OnePole(0.92 - 0.9 * hardness);
      for (let i = 0; i < burst.length; i++) burst[i] = soften.tick(random() * 2 - 1);
      let mean = 0;
      for (const x of burst) mean += x / burst.length;
      const amount = 0.4 + 0.6 * velocity;
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
          // the lips' bandwidth is a fixed share of the note, so low notes still pick out their bore resonance
          if (Math.abs(hz - tuned) > 0.01) { lips.set(hz, 1 - (Math.PI * 0.15 * hz) / sr, 1.4, sr); tuned = hz; }
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
      const ratio = exciter.ratio ?? 0.32;
      const noise = exciter.noise ?? 0.15;
      const top = 0.75 + 0.25 * velocity;
      return {
        closed: true, sign: -1, bore: 1.5,
        tick: (incoming, input, period) => {
          const breath = top * input * (1 + noise * (random() * 2 - 1));
          jet.write(breath - 0.5 * incoming);
          const x = jet.read(period * 1.5 * ratio);
          const split = Math.max(-1, Math.min(1, x * (x * x - 1)));
          return split + 0.5 * incoming - incoming;
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
  // second returns the sample heard (at the bridge, or the bell)
  incoming(hz: number): number;
  inject(e: number): number;
  tail: number;  // seconds it rings after the excitation stops
}

function resonator(resonator: Resonator, excite: Excitation, position: number, sr: number, lowestHz: number): Resonance_ {
  if (resonator.kind === 'string') {
    // Two lines either side of the exciter; rigid at the nut, lossy at the bridge
    const decay = resonator.decay ?? 3;
    const brightness = resonator.brightness ?? 0.5;
    const loss = new OnePole(0.05 + 0.75 * (1 - brightness));
    const stiffness = resonator.stiffness ?? 0;
    const c = stiffness > 0 ? stiffnessCoefficient(lowestHz, stiffness * 0.0012, sr) : 0;
    const allpasses = c ? Array.from({ length: STIFF_SECTIONS }, () => new Allpass(c)) : [];
    const longest = sr / Math.max(10, lowestHz) + 8;
    const neck = new Delay(longest);
    const bridge = new Delay(longest);
    const beta = Math.min(0.5, Math.max(0.02, position));
    let toNeck = 0, toBridge = 0, heard = 0, tuned = 0, dBridge = 0, dNeck = 0;
    return {
      tail: decay,
      incoming(hz) {
        if (Math.abs(hz - tuned) > 1e-3) {
          const w = (2 * Math.PI * hz) / sr;
          const period = sr / hz;
          // the fundamental falls 60 dB in `decay` seconds, whatever the filter does to it
          loss.g = 1;
          loss.g = Math.min(0.99999, Math.pow(10, -3 / (decay * hz)) / loss.magnitude(w));
          const delay = Math.max(2, period - loss.phaseDelay(w) - allpasses.reduce((s, a) => s + a.phaseDelay(w), 0));
          dBridge = delay * beta;
          dNeck = delay - dBridge;
          tuned = hz;
        }
        heard = bridge.read(dBridge);
        let back = loss.tick(heard);
        for (const a of allpasses) back = a.tick(back);
        toNeck = -back;                 // reflected at the bridge
        toBridge = -neck.read(dNeck);   // reflected at the nut
        return toNeck + toBridge;       // the string's velocity under the bow
      },
      inject(e) {
        neck.write(softClip(toNeck + e));
        bridge.write(softClip(toBridge + e));
        return heard;
      }
    };
  }

  // A bore: one line, the round trip to the far end and back
  const end = resonator.end ?? 'open';
  const reflect = end === 'open' ? -1 : 1;
  const lossAmount = resonator.loss ?? 0.5;
  const loss = new OnePole(0.3 + 0.6 * lossAmount, 0.995 - 0.15 * lossAmount);
  const dc = new DcBlocker(sr);
  // With the exciter's own inversion the loop either keeps the wave's sign
  // (every harmonic: a period long) or flips it (odd harmonics: half a period)
  const periods = excite.bore * (reflect * excite.sign < 0 ? 0.5 : 1);
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

function radiate(radiator: Radiator, x: Float32Array, sr: number, noteHz: number) {
  switch (radiator.kind) {
    case 'body': {
      const modes = radiator.modes ?? BODIES[radiator.preset ?? 'box'];
      const mix = radiator.mix ?? 0.7;
      const filters = modes.map((m) => { const f = new StateVariableFilter('bandpass'); f.set(m.hz, m.q, sr); return { f, gain: m.gain }; });
      const norm = 1 / Math.max(1, Math.sqrt(modes.reduce((s, m) => s + m.gain * m.gain, 0)));
      for (let i = 0; i < x.length; i++) {
        let body = 0;
        for (const { f, gain } of filters) body += gain * f.process(x[i]);
        x[i] = (1 - mix) * x[i] + mix * body * norm * 2;
      }
      return;
    }
    case 'helmholtz': {
      const f = new StateVariableFilter('bandpass');
      f.set(radiator.hz ?? 110, radiator.q ?? 6, sr);
      const mix = radiator.mix ?? 0.4;
      for (let i = 0; i < x.length; i++) x[i] = x[i] + mix * 2 * f.process(x[i]);
      return;
    }
    case 'bell': {
      const f = new StateVariableFilter('highpass');
      f.set(radiator.cutoff ?? 700, 0.6, sr);
      const mix = radiator.mix ?? 0.8;
      for (let i = 0; i < x.length; i++) x[i] = (1 - mix) * x[i] + mix * 1.5 * f.process(x[i]);
      return;
    }
    case 'tonehole': {
      const hp = new StateVariableFilter('highpass');
      hp.set(noteHz * (radiator.cutoff ?? 0.7), 0.7, sr);
      const lp = new OnePole(0.75 * (1 - (radiator.brightness ?? 0.6)));
      for (let i = 0; i < x.length; i++) x[i] = lp.tick(hp.process(x[i]));
      return;
    }
    case 'damping': {
      const lp = new OnePole(Math.min(0.99, Math.max(0, radiator.a ?? 0.5)));
      for (let i = 0; i < x.length; i++) x[i] = lp.tick(x[i]);
      return;
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

// How long the resonator rings once nothing excites it
export const modelTail = (layer: ModelLayer) => (layer.resonator.kind === 'string' ? Math.min(10, layer.resonator.decay ?? 3) : 0.25);

// Closed-loop models settle a little off the loop's pitch (the lips, the
// jet and the reed have dynamics of their own), so each note is tuned like an
// instrument: a short probe is played, its pitch measured, and the model
// retuned by the difference (three times, to converge). Cached per configuration.
const tunings = new Map<string, number>();
const PROBE = 0.7;

function tuning(layer: ModelLayer, r: ModelRender): number {
  const key = `${JSON.stringify([layer.exciter, layer.resonator])}|${r.baseHz.toFixed(4)}|${r.velocity.toFixed(3)}|${r.sampleRate}`;
  const cached = tunings.get(key);
  if (cached !== undefined) return cached;
  const n = Math.round(PROBE * r.sampleRate);
  const input = new Float32Array(n).fill(1);
  const probe = new Float32Array(n);
  let correction = 1;
  for (let pass = 0; pass < 3; pass++) {
    probe.fill(0);
    run(layer, r, input, null, correction, probe);
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
  const tune = closedLoop(layer.exciter) && !r.off.has('resonator') ? tuning(layer, r) : 1;
  run(layer, r, input, bend, tune, out);
  (layer.radiators ?? []).forEach((radiator, k) => {
    if (!r.off.has(`radiator:${k}`)) radiate(radiator, out, r.sampleRate, r.baseHz);
  });
}

function run(layer: ModelLayer, r: ModelRender, input: Float32Array, bend: Float64Array | null, tune: number, out: Float32Array) {
  const sr = r.sampleRate;
  const baseHz = r.baseHz * tune;
  const random = createRandom(r.seed);
  const excite = excitation(layer.exciter, { sampleRate: sr, velocity: r.velocity, baseHz, random });
  const position = layer.exciter.kind === 'pluck' ? layer.exciter.position ?? 0.2
    : layer.exciter.kind === 'strike' ? layer.exciter.position ?? 0.12
      : layer.exciter.kind === 'bow' ? layer.exciter.position ?? 0.13 : 0.5;
  let lowest = baseHz;
  if (bend) for (const b of bend) lowest = Math.min(lowest, baseHz * b);
  const ring = r.off.has('resonator') ? null : resonator(layer.resonator, excite, position, sr, lowest);

  for (let i = 0; i < out.length; i++) {
    const hz = bend ? baseHz * bend[i] : baseHz;
    const period = sr / hz;
    if (!ring) {
      out[i] = excite.tick(0, input[i] ?? 0, period);
      continue;
    }
    const back = ring.incoming(hz);
    out[i] = ring.inject(excite.tick(back, input[i] ?? 0, period));
  }
}
