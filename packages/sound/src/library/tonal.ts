// Pitched sounds: basses, keys, mallets, plucks, leads, pads, strings, brass,
// winds, and pitched-down FX.
//
// Strings and pianos are harmonic series whose upper partials die sooner;
// mallets and bells ring at the inharmonic modes of bars and shells; analog
// sounds are band-limited waves through filters; electric pianos are FM.

import type { Category, Layer, Partial as Component, SoundRecipe } from '../types.ts';

const sound = (
  id: string, name: string, category: Category, tags: string[], root: number, length: number, layers: Layer[],
  extra: Partial<SoundRecipe> = {}
): SoundRecipe => ({ id, name, category, tags, pitched: true, root, length, layers, ...extra });

// A plucked or struck string: its harmonics, weighted by where it was plucked
// (a pluck at 1/p of the length silences every p-th harmonic), each dying
// sooner the higher it is
function string(count: number, position: number, slope: number): Component[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { ratio: n, level: Math.abs(Math.sin(n * Math.PI * position)) * Math.pow(n, slope / 6.0206) / Math.sin(Math.PI * position) };
  }).filter((p) => p.level > 0.002);
}

// The thump or scrape of whatever set it going
const strike = (cutoff: number, decay: number, level: number, type: 'lowpass' | 'bandpass' | 'highpass' = 'lowpass'): Layer => ({
  type: 'noise', level, velocity: 1,
  env: { attack: 0.0005, decay, sustain: 0, release: decay },
  filter: { type, cutoff, q: type === 'bandpass' ? 1 : 0.707, keyTrack: 0.5 }
});

// Struck modes: ratios, levels and T60s
const modes = (ratios: number[], levels: number[], decays: number[]): Component[] =>
  ratios.map((ratio, i) => ({ ratio, level: levels[i] ?? levels[levels.length - 1], decay: decays[i] ?? decays[decays.length - 1] }));

// ------------------------------------------------------------------- bass

export const BASS: SoundRecipe[] = [
  sound('bass-sub', 'Sub Bass', 'bass', ['sub', 'sine'], 36, 4, [
    { type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.08 }, { ratio: 3, level: 0.03 }],
      env: { attack: 0.005, sustain: 1, release: 0.12 }, drive: 0.3 }
  ]),
  sound('bass-808', '808 Bass', 'bass', ['808', 'sub', 'long'], 36, 4, [
    { type: 'partials', partials: [{ ratio: 1, level: 1 }], pitch: { amount: 7, time: 0.06 },
      env: { attack: 0.002, decay: 3.5, sustain: 0, release: 0.2 }, drive: 1.6 },
    { type: 'noise', level: 0.08, env: { attack: 0.0005, decay: 0.008, sustain: 0 }, filter: { type: 'highpass', cutoff: 2000 } }
  ]),
  sound('bass-reese', 'Reese Bass', 'bass', ['reese', 'detuned', 'dnb'], 36, 4, [
    { type: 'wave', shape: 'saw', unison: { voices: 2, detune: 22, spread: 0.3 },
      filter: { type: 'lowpass', cutoff: 700, slope: 24, keyTrack: 0.5 }, env: { attack: 0.005, sustain: 1, release: 0.12 } },
    { type: 'partials', partials: [{ ratio: 1, level: 0.6 }], env: { attack: 0.005, sustain: 1, release: 0.1 } }
  ]),
  sound('bass-pluck', 'Pluck Bass', 'bass', ['pluck', 'saw'], 36, 3, [
    { type: 'wave', shape: 'saw',
      filter: { type: 'lowpass', cutoff: 180, q: 1.5, keyTrack: 0.5, velocity: 1, env: { amount: 4.5, attack: 0.001, decay: 0.35, sustain: 0 } },
      env: { attack: 0.002, decay: 1.6, sustain: 0.15, release: 0.12 } }
  ]),
  sound('bass-fm', 'FM Bass', 'bass', ['fm', 'punchy'], 36, 3, [
    { type: 'fm', modRatio: 1, index: 3, indexEnv: { attack: 0.001, decay: 0.4, sustain: 0.25 },
      env: { attack: 0.002, decay: 2, sustain: 0.6, release: 0.1 } },
    { type: 'partials', partials: [{ ratio: 1, level: 0.5 }], env: { attack: 0.002, sustain: 1, release: 0.1 } }
  ]),
  sound('bass-acid', 'Acid Bass', 'bass', ['acid', '303', 'resonant'], 36, 2, [
    { type: 'wave', shape: 'saw',
      filter: { type: 'lowpass', cutoff: 260, q: 7, slope: 24, keyTrack: 0.6, velocity: 1.2, env: { amount: 3.2, attack: 0.001, decay: 0.3, sustain: 0 } },
      env: { attack: 0.002, sustain: 1, release: 0.06 }, drive: 1.2 }
  ]),
  sound('bass-square', 'Square Bass', 'bass', ['square', 'retro'], 36, 3, [
    { type: 'wave', shape: 'square', filter: { type: 'lowpass', cutoff: 1100, keyTrack: 0.5 },
      env: { attack: 0.003, decay: 0.8, sustain: 0.7, release: 0.08 } }
  ]),
  sound('bass-finger', 'Finger Bass', 'bass', ['finger', 'electric', 'string'], 36, 4, [
    { type: 'partials', partials: string(14, 0.18, -8), partialDecay: 3, damping: 0.9, stretch: 0.00005,
      env: { attack: 0.003, sustain: 1, release: 0.08 } },
    strike(1200, 0.02, 0.12)
  ])
];

// ------------------------------------------------------------------- keys

// Hammond drawbars, as harmonics of the 8' (1 = 8', 2 = 4', 3 = 2 2/3', 4 = 2' …)
const drawbars = (levels: Record<number, number>): Component[] =>
  Object.entries(levels).map(([ratio, level]) => ({ ratio: Number(ratio), level }));

export const KEYS: SoundRecipe[] = [
  sound('piano-grand', 'Grand Piano', 'keys', ['piano', 'acoustic'], 60, 6, [
    // Two strings a little apart beat against each other, as unison strings do
    { type: 'partials', partials: string(32, 0.12, -6), stretch: 0.0004, partialDecay: 7, damping: 1.1,
      filter: { type: 'lowpass', cutoff: 1400, keyTrack: 0.7, velocity: 2.5 }, env: { attack: 0.002, sustain: 1, release: 0.35 } },
    { type: 'partials', partials: string(32, 0.12, -6).map((p) => ({ ...p, detune: 1.2 })), stretch: 0.0004, partialDecay: 7, damping: 1.1,
      filter: { type: 'lowpass', cutoff: 1400, keyTrack: 0.7, velocity: 2.5 }, env: { attack: 0.002, sustain: 1, release: 0.35 }, level: 0.8, pan: 0.2 },
    strike(2500, 0.025, 0.12)
  ]),
  sound('piano-electric', 'Electric Piano', 'keys', ['electric piano', 'rhodes', 'fm'], 60, 5, [
    { type: 'fm', modRatio: 1, index: 1.6, indexEnv: { attack: 0.001, decay: 1.4, sustain: 0.15 },
      env: { attack: 0.002, decay: 5, sustain: 0, release: 0.4 }, tremolo: { rate: 4.5, depth: 0.15, delay: 0.3 } },
    { type: 'fm', modRatio: 14, index: 1.2, indexEnv: { attack: 0.001, decay: 0.12, sustain: 0 }, level: 0.25,
      env: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.2 } }
  ]),
  sound('piano-wurli', 'Wurli', 'keys', ['electric piano', 'wurlitzer', 'reedy'], 60, 4, [
    { type: 'fm', modRatio: 1, index: 2.4, indexEnv: { attack: 0.001, decay: 0.7, sustain: 0.35 },
      env: { attack: 0.002, decay: 3, sustain: 0, release: 0.25 }, drive: 1.2, tremolo: { rate: 5.5, depth: 0.2 } }
  ]),
  sound('clav', 'Clav', 'keys', ['clavinet', 'funk'], 60, 3, [
    { type: 'wave', shape: 'pulse', width: 0.15,
      filter: [{ type: 'highpass', cutoff: 250 }, { type: 'lowpass', cutoff: 1800, keyTrack: 0.6, env: { amount: 1.5, attack: 0.001, decay: 0.25, sustain: 0.2 } }],
      env: { attack: 0.001, decay: 1.2, sustain: 0.25, release: 0.04 } },
    strike(4000, 0.008, 0.15, 'highpass')
  ]),
  sound('organ-drawbar', 'Drawbar Organ', 'keys', ['organ', 'hammond'], 60, 4, [
    { type: 'partials', partials: drawbars({ 1: 1, 2: 0.7, 3: 0.5, 4: 0.4, 6: 0.15, 8: 0.1 }), phases: 'random',
      env: { attack: 0.006, sustain: 1, release: 0.04 }, vibrato: { rate: 6.8, depth: 7 } },
    { type: 'noise', level: 0.12, env: { attack: 0.0005, decay: 0.012, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2500, q: 0.8 } }
  ]),
  sound('organ-rock', 'Rock Organ', 'keys', ['organ', 'percussive', 'overdriven'], 60, 4, [
    { type: 'partials', partials: drawbars({ 1: 1, 2: 0.9, 3: 0.6, 4: 0.5 }), phases: 'random',
      env: { attack: 0.004, sustain: 1, release: 0.05 }, drive: 2.5, tremolo: { rate: 6.5, depth: 0.12 } },
    // the percussion stop: a decaying third harmonic on each key
    { type: 'partials', partials: [{ ratio: 3, level: 0.6, decay: 0.5 }], env: { attack: 0.001, sustain: 1, release: 0.05 } }
  ]),
  sound('organ-church', 'Church Organ', 'keys', ['organ', 'pipe', 'church'], 60, 5, [
    { type: 'partials', partials: [1, 2, 3, 4, 5, 6, 8].map((ratio, i) => ({ ratio, level: [1, 0.6, 0.35, 0.3, 0.12, 0.15, 0.1][i] })),
      phases: 'random', env: { attack: 0.08, sustain: 1, release: 0.5 } },
    { type: 'partials', partials: [1, 2, 4].map((ratio) => ({ ratio, level: 0.4, detune: 3 })), pan: 0.4, phases: 'random',
      env: { attack: 0.1, sustain: 1, release: 0.6 } },
    // the chiff of air starting in the pipes
    { type: 'noise', level: 0.12, env: { attack: 0.01, decay: 0.12, sustain: 0.05, release: 0.2 },
      filter: { type: 'bandpass', cutoff: 1200, q: 1.5, keyTrack: 1 } }
  ]),
  sound('harpsichord', 'Harpsichord', 'keys', ['harpsichord', 'baroque', 'string'], 60, 4, [
    { type: 'partials', partials: string(30, 0.08, -3), partialDecay: 3, damping: 0.6, stretch: 0.00008,
      env: { attack: 0.001, sustain: 1, release: 0.15 } },
    strike(5000, 0.01, 0.15, 'highpass')
  ])
];

// ---------------------------------------------------------------- mallets

export const MALLETS: SoundRecipe[] = [
  // Bars are carved so their second mode sits two octaves up
  sound('marimba', 'Marimba', 'mallets', ['marimba', 'wood', 'bar'], 60, 3, [
    { type: 'partials', partials: modes([1, 4, 9.9], [1, 0.35, 0.08], [1.4, 0.3, 0.1]), env: { attack: 0.001, sustain: 1, release: 0.3 } },
    strike(1500, 0.012, 0.15)
  ]),
  sound('vibraphone', 'Vibraphone', 'mallets', ['vibraphone', 'metal', 'bar'], 60, 6, [
    { type: 'partials', partials: modes([1, 4, 10], [1, 0.22, 0.06], [5, 1.2, 0.4]),
      env: { attack: 0.001, sustain: 1, release: 0.6 }, tremolo: { rate: 5, depth: 0.35 } },
    strike(3000, 0.006, 0.08)
  ]),
  sound('glockenspiel', 'Glockenspiel', 'mallets', ['glockenspiel', 'metal', 'bar', 'bright', 'inharmonic'], 84, 4, [
    { type: 'partials', partials: modes([1, 2.76, 5.4, 8.93], [1, 0.4, 0.15, 0.06], [3, 1.4, 0.6, 0.3]), env: { attack: 0.0005, sustain: 1, release: 0.8 } },
    strike(6000, 0.004, 0.1, 'highpass')
  ]),
  sound('kalimba', 'Kalimba', 'mallets', ['kalimba', 'thumb piano', 'tine'], 72, 3, [
    { type: 'partials', partials: modes([1, 6.27, 17.55], [1, 0.12, 0.03], [1.8, 0.25, 0.08]), env: { attack: 0.001, sustain: 1, release: 0.3 } },
    strike(2500, 0.006, 0.12, 'bandpass')
  ]),
  sound('steel-drum', 'Steel Drum', 'mallets', ['steel pan', 'caribbean'], 72, 3, [
    { type: 'partials', partials: modes([1, 2, 3, 4.2, 5.1], [1, 0.7, 0.45, 0.15, 0.08], [1.4, 1, 0.6, 0.25, 0.15]),
      pitch: { amount: 0.25, time: 0.08 }, env: { attack: 0.002, sustain: 1, release: 0.3 } },
    strike(2000, 0.01, 0.1)
  ]),
  sound('music-box', 'Music Box', 'mallets', ['music box', 'tine', 'bright'], 84, 3, [
    { type: 'partials', partials: modes([1, 5.4, 14.2], [1, 0.25, 0.06], [2.4, 0.6, 0.2]), env: { attack: 0.0005, sustain: 1, release: 0.4 } },
    strike(7000, 0.003, 0.08, 'highpass')
  ]),
  // A tube rings at a free bar's modes; we hear the strike note among them
  sound('bell-tubular', 'Tubular Bell', 'mallets', ['bell', 'chime', 'inharmonic'], 72, 7, [
    { type: 'partials', partials: modes([1, 1.5, 2.08, 2.69, 3.4, 4.15], [1, 0.5, 0.45, 0.3, 0.2, 0.1], [6, 4.5, 3.5, 2.5, 1.8, 1.2]),
      env: { attack: 0.001, sustain: 1, release: 1.5 } },
    strike(4000, 0.008, 0.1, 'bandpass')
  ]),
  // A church bell's minor-third series: hum, prime, tierce, quint, nominal …
  sound('bell-church', 'Church Bell', 'mallets', ['bell', 'church', 'inharmonic'], 60, 10, [
    { type: 'partials', partials: modes([0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011, 4.166, 5.433],
      [0.6, 0.8, 0.7, 0.3, 1, 0.35, 0.3, 0.25, 0.2, 0.1], [9, 6, 5, 3.5, 4, 2.5, 2.2, 2, 1.4, 1]),
      phases: 'random', env: { attack: 0.001, sustain: 1, release: 2.5 } },
    strike(2500, 0.015, 0.12, 'bandpass')
  ])
];

// ----------------------------------------------------------------- plucks

export const PLUCKS: SoundRecipe[] = [
  sound('pluck-synth', 'Synth Pluck', 'plucks', ['pluck', 'saw', 'edm'], 60, 2, [
    { type: 'wave', shape: 'saw', unison: { voices: 3, detune: 12, spread: 0.5 },
      filter: { type: 'lowpass', cutoff: 350, q: 1.2, keyTrack: 0.6, velocity: 1, env: { amount: 4.5, attack: 0.001, decay: 0.25, sustain: 0 } },
      env: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.2 } }
  ]),
  sound('pluck-bell', 'Bell Pluck', 'plucks', ['pluck', 'bell', 'fm', 'inharmonic'], 72, 2.5, [
    { type: 'fm', modRatio: 3.5, index: 2.2, indexEnv: { attack: 0.001, decay: 0.3, sustain: 0.1 },
      env: { attack: 0.001, decay: 1.6, sustain: 0, release: 0.3 } }
  ]),
  sound('harp', 'Harp', 'plucks', ['harp', 'string', 'acoustic'], 60, 5, [
    { type: 'partials', partials: string(20, 0.3, -9), partialDecay: 4, damping: 1.2, stretch: 0.00005,
      env: { attack: 0.002, sustain: 1, release: 0.6 } },
    strike(2000, 0.008, 0.08)
  ]),
  sound('koto', 'Koto', 'plucks', ['koto', 'string', 'japanese'], 60, 3, [
    { type: 'partials', partials: string(22, 0.1, -5), partialDecay: 2.2, damping: 0.8,
      pitch: { amount: 0.4, time: 0.12 }, env: { attack: 0.001, sustain: 1, release: 0.3 } },
    strike(4000, 0.01, 0.15, 'highpass')
  ]),
  sound('guitar-nylon', 'Nylon Guitar', 'plucks', ['guitar', 'nylon', 'string', 'acoustic'], 52, 4, [
    { type: 'partials', partials: string(24, 0.16, -7), partialDecay: 3, damping: 1, stretch: 0.00003,
      filter: { type: 'lowpass', cutoff: 2500, keyTrack: 0.5, velocity: 1.5 }, env: { attack: 0.002, sustain: 1, release: 0.25 } },
    // the guitar body's air resonance
    { type: 'noise', level: 0.1, env: { attack: 0.001, decay: 0.08, sustain: 0 }, filter: { type: 'bandpass', cutoff: 110, q: 3 } },
    strike(3000, 0.006, 0.08)
  ]),
  sound('pizzicato', 'Pizzicato Strings', 'plucks', ['pizzicato', 'strings', 'orchestral'], 60, 1.5, [
    { type: 'partials', partials: string(16, 0.22, -8), partialDecay: 0.6, damping: 0.8, env: { attack: 0.002, sustain: 1, release: 0.1 } },
    { type: 'partials', partials: string(16, 0.22, -8).map((p) => ({ ...p, detune: 6 })), partialDecay: 0.55, damping: 0.8,
      env: { attack: 0.003, sustain: 1, release: 0.1 }, level: 0.7, pan: 0.3 }
  ])
];

// ------------------------------------------------------------------ leads

const leadVibrato = { rate: 5.5, depth: 14, delay: 0.25, fade: 0.3 };

export const LEADS: SoundRecipe[] = [
  sound('lead-saw', 'Saw Lead', 'leads', ['saw', 'classic'], 72, 3, [
    { type: 'wave', shape: 'saw', unison: { voices: 3, detune: 12, spread: 0.5 }, vibrato: leadVibrato,
      filter: { type: 'lowpass', cutoff: 3000, keyTrack: 0.5, env: { amount: 1, attack: 0.001, decay: 0.4, sustain: 0.4 } },
      env: { attack: 0.004, sustain: 1, release: 0.15 } }
  ]),
  sound('lead-square', 'Square Lead', 'leads', ['square', 'hollow'], 72, 3, [
    { type: 'wave', shape: 'square', vibrato: leadVibrato,
      filter: { type: 'lowpass', cutoff: 2600, q: 1.2, keyTrack: 0.5 }, env: { attack: 0.004, sustain: 1, release: 0.12 } }
  ]),
  sound('lead-sweep', 'Sweep Lead', 'leads', ['resonant', 'sync', 'sweep'], 72, 3, [
    { type: 'wave', shape: 'saw', vibrato: leadVibrato,
      filter: { type: 'bandpass', cutoff: 700, q: 3.5, keyTrack: 0.8, env: { amount: 2.5, attack: 0.001, decay: 0.5, sustain: 0.3 } },
      env: { attack: 0.003, sustain: 1, release: 0.12 }, drive: 1 },
    { type: 'wave', shape: 'saw', level: 0.35, filter: { type: 'lowpass', cutoff: 1500, keyTrack: 0.5 }, env: { attack: 0.003, sustain: 1, release: 0.12 } }
  ]),
  sound('lead-sine', 'Soft Lead', 'leads', ['sine', 'soft', 'mellow'], 72, 3, [
    { type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.12 }, { ratio: 3, level: 0.05 }],
      vibrato: leadVibrato, env: { attack: 0.03, sustain: 1, release: 0.2 } }
  ]),
  sound('lead-supersaw', 'Supersaw', 'leads', ['supersaw', 'trance', 'wide'], 72, 3, [
    { type: 'wave', shape: 'saw', unison: { voices: 7, detune: 38, spread: 1 },
      filter: { type: 'lowpass', cutoff: 7000, keyTrack: 0.3 }, env: { attack: 0.005, sustain: 1, release: 0.25 } }
  ]),
  sound('lead-chip', 'Chip Lead', 'leads', ['chiptune', 'pulse', '8-bit'], 72, 2, [
    { type: 'wave', shape: 'pulse', width: 0.25, vibrato: { rate: 7, depth: 25, delay: 0.15 },
      env: { attack: 0.001, decay: 0.3, sustain: 0.7, release: 0.03 } }
  ])
];

// ------------------------------------------------------------------- pads

// The formants of a sung "ah": one band-passed layer each, so they add up in
// parallel
const AH = [[800, 1, 5], [1150, 0.5, 6], [2900, 0.25, 8], [3900, 0.15, 9]];

export const PADS: SoundRecipe[] = [
  sound('pad-warm', 'Warm Pad', 'pads', ['warm', 'analog', 'saw'], 60, 5, [
    { type: 'wave', shape: 'saw', unison: { voices: 5, detune: 18, spread: 0.8 },
      filter: { type: 'lowpass', cutoff: 1100, slope: 24, keyTrack: 0.5 }, env: { attack: 0.8, sustain: 1, release: 1.5 } },
    { type: 'wave', shape: 'triangle', level: 0.4, env: { attack: 0.8, sustain: 1, release: 1.5 } }
  ]),
  sound('pad-glass', 'Glass Pad', 'pads', ['glass', 'airy', 'additive'], 60, 5, [
    { type: 'partials', partials: [1, 2, 3, 4.01, 5, 6.02, 8].map((ratio, i) => ({ ratio, level: 1 / (1 + i * 0.7), detune: i % 2 ? 4 : -4, pan: i % 2 ? 0.5 : -0.5 })),
      phases: 'random', vibrato: { rate: 0.3, depth: 6 }, env: { attack: 0.6, sustain: 1, release: 2 } },
    { type: 'fm', modRatio: 4, index: 0.6, level: 0.3, env: { attack: 1.2, sustain: 1, release: 2 } }
  ]),
  sound('pad-choir', 'Choir Pad', 'pads', ['choir', 'vocal', 'aah'], 60, 5, [
    ...AH.map(([cutoff, level, q]): Layer => ({
      type: 'wave', shape: 'saw', level, unison: { voices: 4, detune: 16, spread: 0.7 },
      vibrato: { rate: 5, depth: 10, delay: 0.3, fade: 0.5 },
      filter: { type: 'bandpass', cutoff, q }, env: { attack: 0.35, sustain: 1, release: 0.8 }
    })),
    { type: 'noise', level: 0.05, stereo: true, filter: { type: 'bandpass', cutoff: 1200, q: 1 }, env: { attack: 0.3, sustain: 1, release: 0.6 } }
  ]),
  sound('pad-evolving', 'Evolving Pad', 'pads', ['evolving', 'cinematic', 'slow'], 60, 8, [
    { type: 'wave', shape: 'saw', unison: { voices: 6, detune: 24, spread: 1 },
      filter: { type: 'lowpass', cutoff: 300, q: 2, slope: 24, keyTrack: 0.4, env: { amount: 3.5, attack: 3, decay: 4, sustain: 0.4, release: 2 } },
      env: { attack: 1.5, sustain: 1, release: 2.5 } },
    { type: 'noise', color: 'pink', stereo: true, level: 0.12,
      filter: { type: 'bandpass', cutoff: 1500, q: 1.5, env: { amount: 2, attack: 4, sustain: 0.5 } }, env: { attack: 2, sustain: 1, release: 2 } }
  ]),
  sound('pad-strings', 'String Machine', 'pads', ['strings', 'analog', 'ensemble'], 60, 5, [
    { type: 'wave', shape: 'saw', unison: { voices: 6, detune: 20, spread: 1 }, vibrato: { rate: 5.5, depth: 6 },
      filter: [{ type: 'highpass', cutoff: 180 }, { type: 'lowpass', cutoff: 3200, keyTrack: 0.4 }], env: { attack: 0.35, sustain: 1, release: 0.9 } }
  ]),
  sound('pad-dark', 'Dark Pad', 'pads', ['dark', 'soft', 'ambient'], 60, 6, [
    { type: 'wave', shape: 'triangle', unison: { voices: 4, detune: 14, spread: 0.9 },
      filter: { type: 'lowpass', cutoff: 600, keyTrack: 0.3 }, env: { attack: 1.2, sustain: 1, release: 2 } },
    { type: 'wave', shape: 'saw', level: 0.25, filter: { type: 'lowpass', cutoff: 350, slope: 24, keyTrack: 0.3 }, env: { attack: 1.5, sustain: 1, release: 2 } }
  ])
];

// -------------------------------------------------- strings, brass, winds

export const ORCHESTRA: SoundRecipe[] = [
  sound('strings-ensemble', 'Ensemble Strings', 'strings', ['strings', 'ensemble', 'orchestral', 'legato'], 60, 5, [
    { type: 'wave', shape: 'saw', unison: { voices: 8, detune: 22, spread: 1 }, vibrato: { rate: 5.2, depth: 12, delay: 0.2, fade: 0.4 },
      filter: [{ type: 'lowpass', cutoff: 4200, slope: 24, keyTrack: 0.4, velocity: 1 }, { type: 'highpass', cutoff: 120 }],
      env: { attack: 0.25, sustain: 1, release: 0.6 } },
    // the bodies' resonance around 500 Hz
    { type: 'wave', shape: 'saw', unison: { voices: 3, detune: 10, spread: 0.6 }, level: 0.4,
      filter: { type: 'bandpass', cutoff: 500, q: 1.5 }, env: { attack: 0.3, sustain: 1, release: 0.6 } }
  ]),
  sound('strings-staccato', 'Staccato Strings', 'strings', ['strings', 'staccato', 'orchestral', 'short'], 60, 1, [
    { type: 'wave', shape: 'saw', unison: { voices: 8, detune: 20, spread: 1 },
      filter: [{ type: 'lowpass', cutoff: 3500, slope: 24, keyTrack: 0.4, velocity: 1 }, { type: 'highpass', cutoff: 150 }],
      env: { attack: 0.015, decay: 0.3, sustain: 0, release: 0.1 } },
    { type: 'noise', level: 0.1, env: { attack: 0.002, decay: 0.04, sustain: 0 }, filter: { type: 'bandpass', cutoff: 3000, q: 1 } }
  ]),
  sound('brass-section', 'Brass Section', 'brass', ['brass', 'section', 'stab'], 60, 3, [
    { type: 'wave', shape: 'saw', unison: { voices: 3, detune: 9, spread: 0.6 },
      filter: { type: 'lowpass', cutoff: 500, keyTrack: 0.6, velocity: 1, env: { amount: 2.3, attack: 0.06, decay: 0.5, sustain: 0.55, release: 0.2 } },
      vibrato: { rate: 5, depth: 8, delay: 0.4, fade: 0.4 }, env: { attack: 0.05, sustain: 1, release: 0.18 }, drive: 0.4 }
  ]),
  sound('brass-trumpet', 'Trumpet', 'brass', ['brass', 'trumpet', 'solo'], 72, 3, [
    { type: 'wave', shape: 'saw',
      filter: { type: 'lowpass', cutoff: 700, q: 1.2, keyTrack: 0.7, velocity: 1.2, env: { amount: 2, attack: 0.04, decay: 0.3, sustain: 0.6, release: 0.1 } },
      vibrato: { rate: 5.5, depth: 15, delay: 0.35, fade: 0.3 }, pitch: { amount: -0.6, time: 0.06 },
      env: { attack: 0.03, sustain: 1, release: 0.1 }, drive: 0.6 }
  ]),
  sound('flute', 'Flute', 'winds', ['flute', 'breathy', 'woodwind'], 72, 3, [
    { type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.18 }, { ratio: 3, level: 0.06 }, { ratio: 4, level: 0.02 }],
      vibrato: { rate: 5, depth: 14, delay: 0.3, fade: 0.4 }, env: { attack: 0.07, sustain: 1, release: 0.12 } },
    // breath: noise centred on the note
    { type: 'noise', level: 0.12, filter: { type: 'bandpass', cutoff: 1050, q: 2.5, keyTrack: 1 }, env: { attack: 0.03, decay: 0.3, sustain: 0.5, release: 0.1 } }
  ]),
  sound('clarinet', 'Clarinet', 'winds', ['clarinet', 'reed', 'woodwind'], 60, 3, [
    // a closed pipe: odd harmonics
    { type: 'partials', series: { count: 15, slope: -9, even: 0.06 }, vibrato: { rate: 5, depth: 6, delay: 0.4, fade: 0.4 },
      filter: { type: 'lowpass', cutoff: 2200, keyTrack: 0.5, velocity: 1 }, env: { attack: 0.04, sustain: 1, release: 0.08 } },
    { type: 'noise', level: 0.04, filter: { type: 'bandpass', cutoff: 2000, q: 1.5 }, env: { attack: 0.03, sustain: 1, release: 0.08 } }
  ]),
  sound('pan-flute', 'Pan Flute', 'winds', ['pan flute', 'breathy', 'airy'], 72, 3, [
    { type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.08 }, { ratio: 3, level: 0.12 }],
      vibrato: { rate: 4.5, depth: 10, delay: 0.3, fade: 0.3 }, env: { attack: 0.05, sustain: 1, release: 0.15 } },
    // the chiff at the start, then breath
    { type: 'noise', level: 0.35, filter: { type: 'bandpass', cutoff: 2100, q: 1.2, keyTrack: 1 }, env: { attack: 0.005, decay: 0.08, sustain: 0.25, release: 0.1 } }
  ])
];

// ---------------------------------------------------------------------- fx

const fx = (id: string, name: string, tags: string[], length: number, layers: Layer[]): SoundRecipe =>
  ({ id, name, category: 'fx', tags, pitched: false, root: 60, length, layers });

export const FX: SoundRecipe[] = [
  fx('fx-riser', 'Riser', ['riser', 'build', 'transition'], 4.5, [
    { type: 'noise', stereo: true,
      filter: { type: 'bandpass', cutoff: 300, q: 1.5, env: { amount: 5, attack: 4, sustain: 1 } },
      env: { attack: 3.6, hold: 0.3, decay: 0.15, sustain: 0 } },
    { type: 'wave', shape: 'saw', hz: 220, unison: { voices: 3, detune: 20, spread: 0.8 }, level: 0.35, pitch: { amount: -24, time: 8 },
      filter: { type: 'lowpass', cutoff: 3000 }, env: { attack: 3.6, hold: 0.3, decay: 0.15, sustain: 0 } }
  ]),
  fx('fx-downlifter', 'Downlifter', ['downlifter', 'fall', 'transition'], 5.5, [
    { type: 'noise', stereo: true,
      filter: { type: 'bandpass', cutoff: 8000, q: 1.5, env: { amount: -4.5, attack: 2.5, sustain: 1 } },
      env: { attack: 0.01, decay: 3, sustain: 0 } },
    { type: 'wave', shape: 'saw', hz: 110, level: 0.3, pitch: { amount: 24, time: 2.5 },
      filter: { type: 'lowpass', cutoff: 2500 }, env: { attack: 0.01, decay: 2.8, sustain: 0 } }
  ]),
  fx('fx-impact', 'Impact', ['impact', 'hit', 'boom', 'cinematic'], 5.5, [
    { type: 'partials', hz: 38, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 24, time: 0.35 },
      env: { attack: 0.001, decay: 3, sustain: 0 }, drive: 2 },
    { type: 'noise', stereo: true, level: 0.6, filter: { type: 'lowpass', cutoff: 4000, env: { amount: 1.5, decay: 0.5, sustain: 0 } },
      env: { attack: 0.001, decay: 2.2, sustain: 0 } }
  ]),
  fx('fx-sweep', 'Noise Sweep', ['sweep', 'noise', 'transition'], 6.5, [
    { type: 'noise', stereo: true,
      filter: { type: 'bandpass', cutoff: 250, q: 3, env: { amount: 5.5, attack: 2, decay: 3, sustain: 0 } },
      env: { attack: 1.5, hold: 0.5, decay: 2.5, sustain: 0 } }
  ]),
  fx('fx-zap', 'Zap', ['zap', 'laser', 'retro'], 0.6, [
    { type: 'partials', hz: 120, partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.3 }], pitch: { amount: 48, time: 0.15 },
      env: { attack: 0.0005, decay: 0.3, sustain: 0 } }
  ]),
  fx('fx-laser', 'Laser', ['laser', 'sci-fi'], 1.2, [
    { type: 'wave', shape: 'square', hz: 300, pitch: { amount: 30, time: 0.5 }, vibrato: { rate: 30, depth: 80 },
      filter: { type: 'lowpass', cutoff: 5000 }, env: { attack: 0.001, decay: 0.6, sustain: 0 } }
  ]),
  fx('fx-wind', 'Wind', ['wind', 'ambient', 'texture'], 9, [
    { type: 'noise', color: 'pink', stereo: true, filter: { type: 'bandpass', cutoff: 500, q: 2.5 },
      env: { attack: 2, hold: 1.5, decay: 3, sustain: 0 }, tremolo: { rate: 0.4, depth: 0.5 } },
    { type: 'noise', color: 'pink', stereo: true, level: 0.6, filter: { type: 'bandpass', cutoff: 1300, q: 4 },
      env: { attack: 2.5, hold: 1, decay: 3, sustain: 0 }, tremolo: { rate: 0.27, depth: 0.6 } }
  ]),
  fx('fx-sub-drop', 'Sub Drop', ['sub', 'drop', 'boom'], 5.5, [
    { type: 'partials', hz: 32, partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.1 }], pitch: { amount: 24, time: 2 },
      env: { attack: 0.005, decay: 3, sustain: 0 }, drive: 0.8 }
  ])
];

export const TONAL: SoundRecipe[] = [...BASS, ...KEYS, ...MALLETS, ...PLUCKS, ...LEADS, ...PADS, ...ORCHESTRA, ...FX];
