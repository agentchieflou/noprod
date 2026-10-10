// Physically modeled instruments (#79): each a model layer (src/model.ts),
// an exciter in a resonator heard through radiators, played the way the
// instrument is: bowed strings sustain for as long as the bow moves, brass
// and winds for as long as there's breath, plucked and struck strings ring
// down on their own.

import type { Category, ModelLayer, SoundRecipe } from '../types.ts';

const sound = (
  id: string, name: string, category: Category, tags: string[], root: number, length: number, layers: ModelLayer[]
): SoundRecipe => ({ id, name, category, tags: ['modeled', ...tags], pitched: true, root, length, layers });

const vibrato = (depth: number, rate = 5.5) => ({ rate, depth, delay: 0.25, fade: 0.4 });

// ---------------------------------------------------------------- bowed
// (no stiffness: a bowed string locks its partials into a harmonic series)

const BOWED: SoundRecipe[] = [
  sound('violin', 'Violin', 'strings', ['violin', 'bowed', 'string', 'solo', 'orchestral'], 67, 3, [{
    type: 'model', exciter: { kind: 'bow', pressure: 0.5, position: 0.12, noise: 0.08 },
    resonator: { kind: 'string', decay: 1.2, brightness: 0.6 },
    radiators: [{ kind: 'body', preset: 'violin', mix: 0.75 }],
    vibrato: vibrato(18), env: { attack: 0.08, sustain: 1, release: 0.25 }
  }]),
  sound('viola', 'Viola', 'strings', ['viola', 'bowed', 'string', 'solo', 'orchestral'], 60, 3, [{
    type: 'model', exciter: { kind: 'bow', pressure: 0.5, position: 0.13, noise: 0.08 },
    resonator: { kind: 'string', decay: 1.4, brightness: 0.5 },
    radiators: [{ kind: 'body', preset: 'violin', mix: 0.7 }, { kind: 'helmholtz', hz: 230, q: 5, mix: 0.3 }],
    vibrato: vibrato(16, 5.2), env: { attack: 0.09, sustain: 1, release: 0.3 }
  }]),
  sound('cello', 'Cello', 'strings', ['cello', 'bowed', 'string', 'solo', 'orchestral'], 48, 3, [{
    type: 'model', exciter: { kind: 'bow', pressure: 0.55, position: 0.13, noise: 0.06 },
    resonator: { kind: 'string', decay: 1.8, brightness: 0.5 },
    radiators: [{ kind: 'body', preset: 'cello', mix: 0.75 }],
    vibrato: vibrato(14, 5), env: { attack: 0.1, sustain: 1, release: 0.35 }
  }]),
  sound('double-bass', 'Double Bass', 'strings', ['double bass', 'contrabass', 'bowed', 'string', 'orchestral'], 40, 3, [{
    type: 'model', exciter: { kind: 'bow', pressure: 0.6, position: 0.14, noise: 0.05 },
    resonator: { kind: 'string', decay: 2.2, brightness: 0.4 },
    radiators: [{ kind: 'body', preset: 'cello', mix: 0.6 }, { kind: 'helmholtz', hz: 70, q: 4, mix: 0.3 }],
    vibrato: vibrato(10, 4.8), env: { attack: 0.12, sustain: 1, release: 0.4 }
  }])
];

// ---------------------------------------------------------------- brass

const BRASS: SoundRecipe[] = [
  sound('trumpet-modeled', 'Trumpet (Modeled)', 'brass', ['trumpet', 'brass', 'solo'], 67, 3, [{
    type: 'model', exciter: { kind: 'lips', tension: 1 },
    resonator: { kind: 'bore', end: 'flared', loss: 0.4 },
    radiators: [{ kind: 'bell', cutoff: 900, mix: 0.7 }],
    vibrato: vibrato(10, 5.5), env: { attack: 0.03, sustain: 1, release: 0.1 }
  }]),
  sound('trombone', 'Trombone', 'brass', ['trombone', 'brass', 'solo'], 53, 3, [{
    type: 'model', exciter: { kind: 'lips', tension: 1 },
    resonator: { kind: 'bore', end: 'flared', loss: 0.5 },
    radiators: [{ kind: 'bell', cutoff: 500, mix: 0.6 }],
    vibrato: vibrato(6, 5), env: { attack: 0.04, sustain: 1, release: 0.12 }
  }]),
  // the bell faces away from the listener, behind the player's hand
  sound('french-horn', 'French Horn', 'brass', ['french horn', 'horn', 'brass', 'mellow', 'orchestral'], 53, 3, [{
    type: 'model', exciter: { kind: 'lips', tension: 1 },
    resonator: { kind: 'bore', end: 'flared', loss: 0.65 },
    radiators: [{ kind: 'bell', cutoff: 400, mix: 0.4 }, { kind: 'damping', a: 0.55 }],
    vibrato: vibrato(5, 5), env: { attack: 0.06, sustain: 1, release: 0.18 }
  }])
];

// ---------------------------------------------------------------- winds

const WINDS: SoundRecipe[] = [
  sound('flute-modeled', 'Flute (Modeled)', 'winds', ['flute', 'woodwind', 'breathy', 'solo'], 72, 3, [{
    type: 'model', exciter: { kind: 'jet', ratio: 0.32, noise: 0.15 },
    resonator: { kind: 'bore', end: 'open', loss: 0.4 },
    radiators: [{ kind: 'tonehole', cutoff: 0.7, brightness: 0.6 }],
    vibrato: vibrato(14, 5), env: { attack: 0.06, sustain: 1, release: 0.1 }
  }]),
  sound('recorder', 'Recorder', 'winds', ['recorder', 'woodwind', 'baroque', 'pure'], 72, 3, [{
    type: 'model', exciter: { kind: 'jet', ratio: 0.3, noise: 0.06 },
    resonator: { kind: 'bore', end: 'open', loss: 0.55 },
    radiators: [{ kind: 'tonehole', cutoff: 0.8, brightness: 0.4 }],
    env: { attack: 0.03, sustain: 1, release: 0.06 }
  }]),
  // a reed on a cylinder, open at the far end: the odd harmonics
  sound('clarinet-modeled', 'Clarinet (Modeled)', 'winds', ['clarinet', 'reed', 'woodwind', 'solo'], 60, 3, [{
    type: 'model', exciter: { kind: 'reed', stiffness: 0.5, noise: 0.04 },
    resonator: { kind: 'bore', end: 'open', loss: 0.5 },
    radiators: [{ kind: 'tonehole', cutoff: 0.7, brightness: 0.6 }],
    vibrato: vibrato(4, 5), env: { attack: 0.03, sustain: 1, release: 0.08 }
  }])
];

// ---------------------------------------------------------------- plucked

const PLUCKED: SoundRecipe[] = [
  sound('guitar-nylon-modeled', 'Nylon Guitar (Modeled)', 'plucks', ['guitar', 'nylon', 'string', 'acoustic'], 52, 4, [{
    type: 'model', exciter: { kind: 'pluck', position: 0.16, hardness: 0.4 },
    resonator: { kind: 'string', decay: 3, brightness: 0.4, stiffness: 0.02 },
    radiators: [{ kind: 'body', preset: 'guitar', mix: 0.6 }, { kind: 'helmholtz', hz: 100, q: 6, mix: 0.25 }],
    env: { sustain: 1, release: 0.25 }
  }]),
  sound('guitar-steel', 'Steel Guitar', 'plucks', ['guitar', 'steel', 'string', 'acoustic', 'bright'], 52, 4, [{
    type: 'model', exciter: { kind: 'pluck', position: 0.12, hardness: 0.85 },
    resonator: { kind: 'string', decay: 4, brightness: 0.75, stiffness: 0.02 },
    radiators: [{ kind: 'body', preset: 'guitar', mix: 0.55 }, { kind: 'helmholtz', hz: 100, q: 6, mix: 0.2 }],
    env: { sustain: 1, release: 0.25 }
  }]),
  sound('harp-modeled', 'Harp (Modeled)', 'plucks', ['harp', 'string', 'acoustic'], 60, 5, [{
    type: 'model', exciter: { kind: 'pluck', position: 0.3, hardness: 0.3 },
    resonator: { kind: 'string', decay: 5, brightness: 0.45, stiffness: 0.02 },
    radiators: [{ kind: 'body', preset: 'harp', mix: 0.6 }],
    env: { sustain: 1, release: 0.6 }
  }]),
  // a drum head for a body: bright and short
  sound('banjo', 'Banjo', 'plucks', ['banjo', 'string', 'acoustic', 'bright', 'twangy'], 60, 3, [{
    type: 'model', exciter: { kind: 'pluck', position: 0.09, hardness: 0.9 },
    resonator: { kind: 'string', decay: 1.2, brightness: 0.8, stiffness: 0.03 },
    radiators: [{ kind: 'body', preset: 'box', mix: 0.5 }, { kind: 'bell', cutoff: 600, mix: 0.5 }],
    env: { sustain: 1, release: 0.2 }
  }]),
  sound('pizzicato-violin', 'Pizzicato Violin', 'plucks', ['pizzicato', 'violin', 'string', 'orchestral', 'short'], 67, 1.5, [{
    type: 'model', exciter: { kind: 'pluck', position: 0.25, hardness: 0.25 },
    resonator: { kind: 'string', decay: 0.6, brightness: 0.4 },
    radiators: [{ kind: 'body', preset: 'violin', mix: 0.7 }],
    // a violin's body radiates little below its air resonance
    filter: { type: 'highpass', cutoff: 180 },
    env: { sustain: 1, release: 0.15 }
  }]),
  // courses of two strings, a few cents apart, struck by a hammer
  sound('dulcimer', 'Hammered Dulcimer', 'plucks', ['dulcimer', 'hammered', 'string', 'struck', 'folk'], 60, 4, [
    {
      type: 'model', exciter: { kind: 'strike', position: 0.12, hardness: 0.7 },
      resonator: { kind: 'string', decay: 3, brightness: 0.7, stiffness: 0.08 },
      radiators: [{ kind: 'body', preset: 'box', mix: 0.5 }], pan: -0.3, env: { sustain: 1, release: 0.5 }
    },
    {
      type: 'model', exciter: { kind: 'strike', position: 0.13, hardness: 0.7 }, ratio: 1.0023,
      resonator: { kind: 'string', decay: 3, brightness: 0.7, stiffness: 0.08 },
      radiators: [{ kind: 'body', preset: 'box', mix: 0.5 }], pan: 0.3, env: { sustain: 1, release: 0.5 }
    }
  ])
];

export const MODELED: SoundRecipe[] = [...BOWED, ...BRASS, ...WINDS, ...PLUCKED];
