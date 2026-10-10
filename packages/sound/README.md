# @noprod/sound

noprod's sound library, built from scratch. No recordings: every sound is a
**recipe**, an arrangement of frequencies that changes over time, and
`render` turns a recipe into samples.

## The model

Any sound is a sum of sine waves (Fourier). Two refinements make that usable
for a library:

- **The arrangement changes over time.** Every component has its own
  envelope: a piano's upper partials die before its fundamental, a kick
  falls in pitch.
- **Noisy sounds are bands, not lists.** A hat or a breath would take
  thousands of sines; it is written as a band of noise (every frequency in a
  range, random phases) shaped by a filter.

A recipe is a list of layers:

| Layer | Frequencies | For |
|---|---|---|
| `partials` | sines at any ratios, each with its own level and decay; `series` for a harmonic series, `stretch` for inharmonicity, `damping` for higher partials dying sooner | bells, mallets, piano, organ, drum bodies |
| `wave` | a saw, square, triangle, pulse or custom harmonic series, band-limited to the note; several oscillators (`ratios`) and `unison` | basses, leads, pads |
| `fm` | a carrier and a modulator: sidebands at carrier ± k·modulator | electric pianos, metallic sounds |
| `noise` | white, pink or brown | hats, snares, breath, FX |

Every layer can have an amplitude envelope, a pitch envelope, vibrato,
filters (with their own envelopes, key tracking and velocity), drive, a start
offset, a level and a pan. Decays are T60s: the time to fall 60 dB.

```ts
import { render, encodeWav, type SoundRecipe } from '@noprod/sound';

const bell: SoundRecipe = {
  id: 'example-bell', name: 'Bell', category: 'mallets', pitched: true, root: 72, length: 4,
  layers: [{
    type: 'partials',
    partials: [
      { ratio: 0.5, level: 0.4, decay: 4 }, { ratio: 1, level: 1, decay: 3 },
      { ratio: 1.19, level: 0.5, decay: 2 }, { ratio: 1.56, level: 0.4, decay: 1.5 },
      { ratio: 2, level: 0.5, decay: 1.2 }, { ratio: 2.66, level: 0.3, decay: 0.8 }
    ],
    env: { attack: 0.001, sustain: 1, release: 1 }
  }]
};

const { left, right, sampleRate } = render(bell, { note: 76, velocity: 0.8, gate: 1 });
const wav = encodeWav([left, right], sampleRate, 24);
```

Rendering is deterministic: the same recipe, note, velocity and gate give the
same samples (noise is seeded from the recipe's id and `seed`). Sounds are
normalized to the same loudness (-18 dBFS RMS over 300 ms, peaks at most
-1 dBFS), measured at the root note; `gain` trims a recipe from there.

## Tests

```sh
npm test --workspace=packages/sound       # node --test, no build step
npm run typecheck --workspace=packages/sound
```

Nothing in CI can listen, so the tests measure (`src/analysis.ts`): the pitch
of each note, harmonic levels, aliasing, envelope times, noise bands, FM
sidebands, panning, loudness and determinism.
