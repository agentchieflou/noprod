// Hand percussion and small instruments: wood, metal, skins and shakers.

import type { Layer, SoundRecipe } from '../types.ts';
import { MEMBRANE } from './drums.ts';

const perc = (id: string, name: string, tags: string[], length: number, layers: Layer[]): SoundRecipe =>
  ({ id, name, category: 'percussion', tags, pitched: false, length, layers });

// Struck wood or metal: a few inharmonic modes, each with its own decay
const modes = (hz: number, ratios: number[], decays: number[], levels: number[], level = 1): Layer => ({
  type: 'partials', hz, level,
  partials: ratios.map((ratio, i) => ({ ratio, level: levels[i] ?? levels[levels.length - 1], decay: decays[i] ?? decays[decays.length - 1] })),
  env: { attack: 0.0003, sustain: 1 }
});

const tap = (cutoff: number, decay: number, level: number): Layer => ({
  type: 'noise', level, env: { attack: 0.0003, decay, sustain: 0 }, filter: { type: 'bandpass', cutoff, q: 1.2 }
});

// A hand drum: membrane modes, the open tone, and the slap of the hand
function handDrum(id: string, name: string, hz: number, decay: number, slap: number, tags: string[]): SoundRecipe {
  return perc(id, name, ['hand drum', ...tags], decay * 2.5, [
    { type: 'partials', hz, partials: MEMBRANE.slice(0, 4).map((ratio, i) => ({ ratio, level: i ? 0.35 / i : 1, decay: decay / (1 + i) })),
      pitch: { amount: 2, time: 0.04 }, env: { attack: 0.0005, sustain: 1 } },
    { type: 'noise', level: slap, env: { attack: 0.0005, decay: 0.03, sustain: 0 },
      filter: [{ type: 'highpass', cutoff: 1200 }, { type: 'lowpass', cutoff: 6000 }] }
  ]);
}

// Beads or seeds: soft-edged bursts of high noise
const shake = (start: number, level: number, decay: number): Layer => ({
  type: 'noise', start, level, stereo: true,
  env: { attack: 0.012, decay, sustain: 0 },
  filter: [{ type: 'highpass', cutoff: 4500, slope: 24 }, { type: 'lowpass', cutoff: 13000 }]
});

export const PERCUSSION: SoundRecipe[] = [
  perc('rim', 'Side Stick', ['rim', 'stick'], 0.4, [
    modes(500, [1, 2.4, 3.4], [0.06, 0.03, 0.025], [1, 0.5, 0.5]),
    tap(3000, 0.008, 0.6)
  ]),
  perc('cowbell', 'Cowbell', ['cowbell', '808', 'metal'], 0.8, [
    { type: 'wave', shape: 'square', hz: 540, ratios: [1, 1.4815],
      filter: [{ type: 'bandpass', cutoff: 1100, q: 1.2 }, { type: 'highpass', cutoff: 400 }],
      env: { attack: 0.0005, hold: 0.01, decay: 0.35, sustain: 0 } },
    { type: 'wave', shape: 'square', hz: 540, ratios: [1, 1.4815], level: 0.6,
      filter: { type: 'bandpass', cutoff: 2600, q: 1.5 }, env: { attack: 0.0005, decay: 0.05, sustain: 0 } }
  ]),
  perc('clave', 'Clave', ['clave', 'wood'], 0.3, [
    modes(2500, [1, 2.8], [0.07, 0.03], [1, 0.25]),
    tap(5000, 0.003, 0.2)
  ]),
  perc('woodblock-high', 'High Wood Block', ['woodblock', 'wood', 'high'], 0.4, [
    modes(1100, [1, 2.7, 4.1], [0.09, 0.045, 0.03], [1, 0.4, 0.25]),
    tap(4000, 0.004, 0.3)
  ]),
  perc('woodblock-low', 'Low Wood Block', ['woodblock', 'wood', 'low'], 0.45, [
    modes(780, [1, 2.7, 4.1], [0.11, 0.05, 0.035], [1, 0.4, 0.25]),
    tap(3000, 0.004, 0.3)
  ]),
  perc('shaker', 'Shaker', ['shaker'], 0.35, [shake(0, 1, 0.09), shake(0.018, 0.5, 0.06)]),
  perc('maracas', 'Maracas', ['shaker', 'maracas'], 0.25, [shake(0, 1, 0.05)]),
  perc('cabasa', 'Cabasa', ['shaker', 'cabasa'], 0.35, [
    { ...shake(0, 1, 0.12), env: { attack: 0.004, decay: 0.12, sustain: 0 } }
  ]),
  perc('tambourine', 'Tambourine', ['tambourine', 'metal', 'jingle'], 1, [
    modes(4300, [1, 1.21, 1.47, 1.8, 2.3], [0.35, 0.3, 0.25, 0.2, 0.15], [1, 0.8, 0.6, 0.5, 0.4], 0.3),
    { type: 'noise', stereo: true, level: 0.7, env: { attack: 0.001, decay: 0.3, sustain: 0 },
      filter: [{ type: 'highpass', cutoff: 7000, slope: 24 }, { type: 'lowpass', cutoff: 15000 }] },
    { type: 'noise', stereo: true, start: 0.03, level: 0.4, env: { attack: 0.001, decay: 0.2, sustain: 0 },
      filter: { type: 'highpass', cutoff: 7500, slope: 24 } },
    tap(1500, 0.01, 0.3)
  ]),
  perc('triangle-open', 'Open Triangle', ['triangle', 'metal'], 5, [
    modes(1250, [1, 2.04, 3.1, 4.3, 5.42, 6.6], [3, 2.6, 2.2, 1.8, 1.5, 1.2], [1, 0.6, 0.5, 0.4, 0.3, 0.25]),
    tap(6000, 0.003, 0.2)
  ]),
  perc('triangle-muted', 'Muted Triangle', ['triangle', 'metal', 'muted'], 0.4, [
    modes(1250, [1, 2.04, 3.1, 4.3], [0.12, 0.1, 0.08, 0.06], [1, 0.6, 0.5, 0.4]),
    tap(6000, 0.003, 0.2)
  ]),
  handDrum('conga-high', 'High Conga', 330, 0.25, 0.4, ['conga', 'high']),
  handDrum('conga-low', 'Low Conga', 220, 0.32, 0.35, ['conga', 'low']),
  perc('conga-muted', 'Muted Conga', ['hand drum', 'conga', 'muted'], 0.3, [
    { type: 'partials', hz: 330, partials: [{ ratio: 1, level: 1, decay: 0.06 }, { ratio: 1.594, level: 0.3, decay: 0.04 }],
      env: { attack: 0.0005, sustain: 1 } },
    tap(2500, 0.02, 0.5)
  ]),
  handDrum('bongo-high', 'High Bongo', 480, 0.16, 0.3, ['bongo', 'high']),
  handDrum('bongo-low', 'Low Bongo', 360, 0.2, 0.3, ['bongo', 'low']),
  handDrum('timbale-high', 'High Timbale', 520, 0.45, 0.5, ['timbale', 'high']),
  handDrum('timbale-low', 'Low Timbale', 390, 0.5, 0.5, ['timbale', 'low']),
  perc('agogo-high', 'High Agogo', ['agogo', 'bell', 'metal'], 1.2, [
    modes(980, [1, 2.76, 5.4], [0.6, 0.3, 0.15], [1, 0.35, 0.15]), tap(4000, 0.004, 0.2)
  ]),
  perc('agogo-low', 'Low Agogo', ['agogo', 'bell', 'metal'], 1.2, [
    modes(660, [1, 2.76, 5.4], [0.7, 0.35, 0.18], [1, 0.35, 0.15]), tap(3000, 0.004, 0.2)
  ]),
  perc('guiro', 'Guiro', ['guiro', 'scrape'], 0.6, Array.from({ length: 12 }, (_, i): Layer => ({
    type: 'noise', start: i * 0.028, level: 1 - i * 0.04,
    env: { attack: 0.001, decay: 0.02, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2800, q: 2 }
  }))),
  perc('vibraslap', 'Vibraslap', ['vibraslap', 'rattle'], 1.4, Array.from({ length: 16 }, (_, i): Layer => ({
    type: 'partials', hz: 2300, start: i * 0.045, level: Math.pow(0.82, i),
    partials: [{ ratio: 1, level: 1 }, { ratio: 1.6, level: 0.6 }, { ratio: 2.7, level: 0.4 }],
    env: { attack: 0.0005, decay: 0.05, sustain: 0 }
  }))),
  perc('whistle', 'Whistle', ['whistle'], 0.6, [
    { type: 'partials', hz: 2600, partials: [{ ratio: 1, level: 1 }], vibrato: { rate: 28, depth: 60 },
      env: { attack: 0.01, hold: 0.35, decay: 0.08, sustain: 0 } },
    { type: 'noise', level: 0.15, env: { attack: 0.01, hold: 0.35, decay: 0.08, sustain: 0 },
      filter: { type: 'bandpass', cutoff: 2600, q: 3 } }
  ]),
  perc('cuica', 'Cuica', ['cuica'], 0.7, [
    { type: 'partials', hz: 400, partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.3 }], pitch: { amount: 9, time: 0.35 },
      env: { attack: 0.01, decay: 0.4, sustain: 0 }, drive: 0.5 }
  ])
];
