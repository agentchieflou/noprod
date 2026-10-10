// Drums and cymbals, from frequencies.
//
// A drum head rings at the modes of a circular membrane, which aren't
// harmonic; snare wires, a beater's click and hats' sizzle are bands of
// noise; 808-style hats and cymbals are six square waves at clashing
// frequencies, filtered high.

import type { Layer, SoundRecipe } from '../types.ts';

// Ratios of a circular membrane's first modes to its fundamental
export const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653, 2.918];

// The six oscillators of the TR-808's cymbal and hats, as ratios of 205.3 Hz
export const METAL = [1, 1.4827, 1.8003, 2.546, 2.6303, 3.8968];

// A struck membrane: its modes decaying, the higher ones sooner and quieter
function membrane(hz: number, decay: number, options: { modes?: number; bend?: number; level?: number; brightness?: number } = {}): Layer {
  const { modes = 4, bend = 3, level = 1, brightness = 0.5 } = options;
  return {
    type: 'partials',
    hz,
    level,
    partials: MEMBRANE.slice(0, modes).map((ratio, i) => ({
      ratio, level: i === 0 ? 1 : brightness / i, decay: decay / (1 + i * 0.8)
    })),
    pitch: bend ? { amount: bend, time: decay * 0.3 } : undefined,
    env: { attack: 0.0005, sustain: 1 }
  };
}

// A short burst of noise: the stick or beater hitting
function click(cutoff: number, decay: number, level: number, type: 'highpass' | 'bandpass' | 'lowpass' = 'bandpass'): Layer {
  return {
    type: 'noise', level,
    env: { attack: 0.0003, decay, sustain: 0 },
    filter: { type, cutoff, q: type === 'bandpass' ? 1.2 : 0.707 }
  };
}

// Six square waves, clashing: the 808's metal
function metal(hz: number, highpass: number, decay: number, level = 1, attack = 0.0005): Layer {
  return {
    type: 'wave', shape: 'square', hz, ratios: METAL, level,
    filter: [{ type: 'bandpass', cutoff: highpass * 1.3, q: 0.9 }, { type: 'highpass', cutoff: highpass, slope: 24 }],
    env: { attack, decay, sustain: 0 }
  };
}

const drum = (id: string, name: string, tags: string[], length: number, layers: Layer[], extra: Partial<SoundRecipe> = {}): SoundRecipe =>
  ({ id, name, category: 'drums', tags, pitched: false, length, layers, ...extra });

// ------------------------------------------------------------------- kicks

export const KICKS: SoundRecipe[] = [
  drum('kick-808', '808 Kick', ['kick', '808'], 2.5, [
    { type: 'partials', hz: 49, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 14, time: 0.09 },
      env: { attack: 0.001, decay: 1.4, sustain: 0 }, drive: 0.6 },
    click(1800, 0.006, 0.12, 'highpass')
  ]),
  drum('kick-punchy', 'Punchy Kick', ['kick', 'house', 'techno'], 1, [
    { type: 'partials', hz: 52, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 24, time: 0.055 },
      env: { attack: 0.0005, hold: 0.02, decay: 0.45, sustain: 0 }, drive: 1.5 },
    click(3500, 0.01, 0.3),
    { type: 'partials', hz: 180, partials: [{ ratio: 1, level: 1 }], level: 0.25, pitch: { amount: 7, time: 0.02 },
      env: { attack: 0.0005, decay: 0.04, sustain: 0 } }
  ]),
  drum('kick-deep', 'Deep Kick', ['kick', 'sub'], 2, [
    { type: 'partials', hz: 42, partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.08 }], pitch: { amount: 20, time: 0.1 },
      env: { attack: 0.001, hold: 0.04, decay: 0.9, sustain: 0 }, drive: 0.4 },
    click(2500, 0.008, 0.12)
  ]),
  drum('kick-short', 'Short Kick', ['kick', 'tight'], 0.6, [
    { type: 'partials', hz: 60, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 24, time: 0.04 },
      env: { attack: 0.0005, decay: 0.18, sustain: 0 }, drive: 0.8 },
    click(4000, 0.008, 0.35)
  ]),
  drum('kick-distorted', 'Distorted Kick', ['kick', 'hard', 'distorted'], 1.2, [
    { type: 'partials', hz: 50, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 30, time: 0.07 },
      env: { attack: 0.0005, hold: 0.03, decay: 0.6, sustain: 0 }, drive: 6,
      filter: { type: 'lowpass', cutoff: 2500 } },
    click(3000, 0.012, 0.25)
  ]),
  drum('kick-acoustic', 'Acoustic Kick', ['kick', 'acoustic'], 1, [
    membrane(56, 0.35, { modes: 5, bend: 5, brightness: 0.35 }),
    { type: 'noise', level: 0.35, color: 'pink', env: { attack: 0.0005, decay: 0.15, sustain: 0 },
      filter: { type: 'bandpass', cutoff: 110, q: 1.5 } },
    click(3000, 0.02, 0.2, 'lowpass')
  ]),
  drum('kick-lofi', 'Lo-Fi Kick', ['kick', 'lofi'], 0.8, [
    { type: 'partials', hz: 55, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 18, time: 0.05 },
      env: { attack: 0.001, decay: 0.35, sustain: 0 }, drive: 3, filter: { type: 'lowpass', cutoff: 900 } },
    { type: 'noise', color: 'brown', level: 0.3, env: { attack: 0.001, decay: 0.1, sustain: 0 },
      filter: { type: 'lowpass', cutoff: 1200 } }
  ])
];

// ------------------------------------------------------------------ snares

// The snare wires: bright noise ringing on after the head
const wires = (cutoff: number, decay: number, level: number): Layer => ({
  type: 'noise', level, stereo: true,
  env: { attack: 0.0005, decay, sustain: 0 },
  filter: [{ type: 'highpass', cutoff }, { type: 'lowpass', cutoff: 12000 }]
});

export const SNARES: SoundRecipe[] = [
  drum('snare-acoustic', 'Acoustic Snare', ['snare', 'acoustic'], 1, [
    membrane(185, 0.18, { modes: 5, bend: 2, brightness: 0.6 }),
    wires(1800, 0.28, 0.7),
    click(4500, 0.012, 0.35)
  ]),
  drum('snare-tight', 'Tight Snare', ['snare', 'tight'], 0.6, [
    membrane(230, 0.09, { modes: 3, bend: 3, brightness: 0.5 }),
    wires(3000, 0.14, 0.8)
  ]),
  drum('snare-808', '808 Snare', ['snare', '808'], 0.8, [
    { type: 'partials', hz: 180, partials: [{ ratio: 1, level: 1, decay: 0.16 }, { ratio: 1.83, level: 0.6, decay: 0.1 }],
      pitch: { amount: 2, time: 0.03 }, env: { attack: 0.0005, sustain: 1 } },
    { type: 'noise', level: 0.9, env: { attack: 0.0005, decay: 0.22, sustain: 0 },
      filter: [{ type: 'highpass', cutoff: 1800 }, { type: 'lowpass', cutoff: 9000 }] }
  ]),
  drum('snare-rimshot', 'Rimshot Snare', ['snare', 'rim'], 0.8, [
    membrane(200, 0.15, { modes: 4, bend: 2, brightness: 0.5 }),
    { type: 'partials', hz: 480, partials: [{ ratio: 1, level: 1 }, { ratio: 2.3, level: 0.6 }, { ratio: 3.7, level: 0.4 }],
      level: 0.6, env: { attack: 0.0003, decay: 0.05, sustain: 0 } },
    wires(2200, 0.22, 0.6),
    click(3000, 0.006, 0.6)
  ]),
  drum('snare-brush', 'Brush Snare', ['snare', 'brush', 'soft'], 0.8, [
    { type: 'noise', color: 'pink', stereo: true, env: { attack: 0.012, decay: 0.3, sustain: 0 },
      filter: { type: 'bandpass', cutoff: 3500, q: 0.6 } },
    membrane(200, 0.08, { modes: 2, bend: 0, level: 0.25 })
  ]),
  drum('snare-lofi', 'Lo-Fi Snare', ['snare', 'lofi'], 0.7, [
    membrane(190, 0.12, { modes: 3, bend: 2, brightness: 0.5 }),
    { type: 'noise', level: 0.7, env: { attack: 0.0005, decay: 0.2, sustain: 0 }, drive: 2,
      filter: [{ type: 'highpass', cutoff: 1200 }, { type: 'lowpass', cutoff: 5000 }] }
  ])
];

// ------------------------------------------------------------------- claps

// Several hands a few milliseconds apart, then the room
function clap(id: string, name: string, cutoff: number, bursts: number[], tail: number, extra: string[] = []): SoundRecipe {
  const band = { type: 'bandpass' as const, cutoff, q: 1.4 };
  return drum(id, name, ['clap', ...extra], tail * 2 + 0.2, [
    ...bursts.map((start, i): Layer => ({
      type: 'noise', start, level: 1 - i * 0.1, pan: (i % 2 ? 0.15 : -0.15) * Math.min(1, i),
      env: { attack: 0.0005, decay: 0.03, sustain: 0 }, filter: band
    })),
    { type: 'noise', stereo: true, start: bursts[bursts.length - 1], level: 0.6,
      env: { attack: 0.001, decay: tail, sustain: 0 }, filter: { ...band, q: 0.9 } }
  ], { category: 'drums' });
}

export const CLAPS: SoundRecipe[] = [
  clap('clap', 'Clap', 1200, [0, 0.011, 0.023, 0.034], 0.22),
  clap('clap-big', 'Big Clap', 1000, [0, 0.009, 0.019, 0.031, 0.04], 0.45, ['room']),
  drum('clap-snap', 'Finger Snap', ['clap', 'snap'], 0.4, [
    { type: 'noise', env: { attack: 0.0003, decay: 0.05, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2600, q: 2 } },
    { type: 'noise', start: 0.006, level: 0.6, env: { attack: 0.0003, decay: 0.03, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2600, q: 2 } },
    { type: 'partials', hz: 1800, partials: [{ ratio: 1, level: 1 }], level: 0.35, env: { attack: 0.0003, decay: 0.03, sustain: 0 } }
  ])
];

// -------------------------------------------------------------------- hats

// Acoustic hats are mostly noise with a little metal; 808 hats the reverse
const sizzle = (cutoff: number, decay: number, level: number, attack = 0.0005): Layer => ({
  type: 'noise', level, stereo: true,
  env: { attack, decay, sustain: 0 },
  filter: [{ type: 'highpass', cutoff, slope: 24 }, { type: 'lowpass', cutoff: 16000 }]
});

export const HATS: SoundRecipe[] = [
  drum('hat-closed', 'Closed Hat', ['hat', 'closed', 'acoustic'], 0.4, [
    sizzle(7000, 0.07, 0.8), metal(410, 7500, 0.05, 0.4), click(9000, 0.004, 0.3)
  ]),
  drum('hat-open', 'Open Hat', ['hat', 'open', 'acoustic'], 1.6, [
    sizzle(6500, 0.7, 0.7), metal(410, 7000, 0.55, 0.45), click(9000, 0.004, 0.25)
  ]),
  drum('hat-pedal', 'Pedal Hat', ['hat', 'pedal', 'acoustic'], 0.3, [
    sizzle(5000, 0.05, 0.6, 0.004), metal(410, 6000, 0.04, 0.3, 0.004),
    { type: 'noise', level: 0.3, env: { attack: 0.002, decay: 0.03, sustain: 0 }, filter: { type: 'bandpass', cutoff: 900, q: 1.5 } }
  ]),
  drum('hat-808-closed', '808 Closed Hat', ['hat', 'closed', '808'], 0.3, [
    metal(205.3, 7000, 0.05), sizzle(9000, 0.04, 0.2)
  ]),
  drum('hat-808-open', '808 Open Hat', ['hat', 'open', '808'], 1.2, [
    metal(205.3, 7000, 0.45), sizzle(9000, 0.3, 0.2)
  ])
];

// ---------------------------------------------------------------- cymbals

// A bright wash: metal plus noise, ringing long, with a darker body below
function cymbal(id: string, name: string, tags: string[], decay: number, options: { hz?: number; cutoff?: number; body?: number; drive?: number } = {}): SoundRecipe {
  const { hz = 330, cutoff = 4000, body = 0.3, drive = 0 } = options;
  return drum(id, name, ['cymbal', ...tags], decay * 1.8, [
    { ...metal(hz, cutoff, decay * 0.8, 0.7, 0.002), drive },
    { ...sizzle(cutoff * 1.4, decay, 0.6, 0.002), drive },
    { type: 'noise', level: body, stereo: true, env: { attack: 0.002, decay: decay * 0.5, sustain: 0 },
      filter: { type: 'bandpass', cutoff: cutoff * 0.6, q: 0.8 } }
  ]);
}

// A ride's ping: inharmonic partials of a thick plate
const PLATE = [1, 1.47, 2.09, 2.56, 2.98, 3.53, 4.22, 5.1];

export const CYMBALS: SoundRecipe[] = [
  cymbal('crash', 'Crash', ['crash'], 2.2),
  cymbal('crash-dark', 'Dark Crash', ['crash', 'dark'], 2.6, { hz: 260, cutoff: 2800, body: 0.45 }),
  cymbal('splash', 'Splash', ['splash'], 0.8, { hz: 420, cutoff: 5500, body: 0.2 }),
  cymbal('china', 'China', ['china'], 1.8, { hz: 300, cutoff: 3000, body: 0.6, drive: 2 }),
  drum('ride', 'Ride', ['cymbal', 'ride'], 4, [
    { type: 'partials', hz: 520, partials: PLATE.map((ratio, i) => ({ ratio, level: 1 / (1 + i * 0.4), decay: 2.5 / (1 + i * 0.3) })),
      phases: 'random', level: 0.35, env: { attack: 0.0005, sustain: 1 } },
    sizzle(6000, 1.6, 0.5, 0.001),
    metal(380, 7000, 0.8, 0.3, 0.001),
    click(5000, 0.005, 0.3)
  ]),
  drum('ride-bell', 'Ride Bell', ['cymbal', 'ride', 'bell'], 3.5, [
    { type: 'partials', hz: 740, partials: [1, 2.02, 2.76, 3.9, 5.4].map((ratio, i) => ({ ratio, level: 1 / (1 + i * 0.6), decay: 1.8 / (1 + i * 0.5) })),
      env: { attack: 0.0005, sustain: 1 } },
    sizzle(7000, 0.9, 0.25, 0.001),
    click(4000, 0.004, 0.3)
  ])
];

// ------------------------------------------------------------------- toms

function tom(id: string, name: string, hz: number, decay: number, tags: string[] = []): SoundRecipe {
  return drum(id, name, ['tom', 'acoustic', ...tags], decay * 2.4, [
    membrane(hz, decay, { modes: 4, bend: 4, brightness: 0.4 }),
    { type: 'noise', level: 0.18, color: 'pink', env: { attack: 0.0005, decay: decay * 0.4, sustain: 0 },
      filter: { type: 'bandpass', cutoff: hz * 2, q: 1.2 } },
    click(4000, 0.012, 0.25, 'lowpass')
  ]);
}

export const TOMS: SoundRecipe[] = [
  tom('tom-low', 'Low Tom', 82, 0.6, ['low', 'floor']),
  tom('tom-mid', 'Mid Tom', 123, 0.45, ['mid']),
  tom('tom-high', 'High Tom', 165, 0.35, ['high']),
  drum('tom-electronic', 'Electronic Tom', ['tom', 'electronic'], 1.2, [
    { type: 'partials', hz: 110, partials: [{ ratio: 1, level: 1 }], pitch: { amount: 12, time: 0.35 },
      env: { attack: 0.0005, decay: 0.6, sustain: 0 }, drive: 0.5 },
    { type: 'noise', level: 0.2, env: { attack: 0.0005, decay: 0.05, sustain: 0 }, filter: { type: 'bandpass', cutoff: 1500, q: 1 } }
  ])
];

export const DRUMS: SoundRecipe[] = [...KICKS, ...SNARES, ...CLAPS, ...HATS, ...CYMBALS, ...TOMS];
