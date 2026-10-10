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

| `model` | a physical model: an exciter in a resonator, heard through radiators (below) | strings, brass, winds |

### Physical models

A `model` layer is the three-stage acoustic pipeline as digital waveguides
(`src/model.ts`):

1. **Exciter.** `pluck` or `strike` (open loop: set going once), or `bow`
   (stick-slip friction), `lips` (a mass-spring valve with Bernoulli flow),
   `jet` (an air jet's cubic split at an edge), `reed` (closed loop: each
   sample they read the wave coming back and add their own, for as long as
   the player keeps going).
2. **Resonator.** `string` (two delay lines either side of the exciter,
   rigid at the nut, damped at the bridge; `decay` is the fundamental's T60,
   `stiffness` stretches the partials as B ≈ 0.0012·stiffness) or `bore`
   (one line, its far end `open`, `stopped` or `flared`).
3. **Radiators,** in series: `body` (a bank of wooden modes beside the
   direct sound), `helmholtz` (the air cavity), `bell` (a high-pass),
   `tonehole`, `damping` (H(z) = (1 − a)/(1 − a·z⁻¹)).

The layer's envelope is the player's input: bow speed or breath pressure for
the closed-loop exciters, a damper for plucks and strikes. Loop lengths are
corrected for the phase delay of the filters in them, and closed-loop models
(whose lips, jets and reeds settle a little off the loop's pitch) are tuned
by a short probe note, measured and corrected, cached per configuration.

Any block of any layer can be switched off without losing its settings:
`bypass: ['radiator:0', 'filter:1', 'drive', …]`.

Every layer can have an amplitude envelope, a pitch envelope, vibrato,
tremolo, filters (with their own envelopes, key tracking and velocity), drive
(with a DC blocker after it), a start offset, a level and a pan. Decays are
T60s: the time to fall 60 dB.

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

## The library

`LIBRARY` holds every built-in sound, `KITS` the drum kits (library sounds on
the General MIDI drum notes, with hat chokes). So far:

- **Drums** (`src/library/drums.ts`): 7 kicks, 6 snares, 3 claps, 5 hats, 6
  cymbals, 4 toms. Drum heads ring at a circular membrane's modes; snare
  wires, sizzle and beater clicks are noise bands; 808 hats and cymbals are
  six clashing square waves.
- **Percussion** (`src/library/percussion.ts`): 24 sounds: rim, cowbell,
  clave, wood blocks, shakers, tambourine, triangles, congas, bongos,
  timbales, agogos, guiro, vibraslap, whistle, cuica.
- **Tonal** (`src/library/tonal.ts`): 57 sounds.
  - Bass (8): sub, 808, reese, pluck, FM, acid, square, finger.
  - Keys (8): grand piano (stretched, damped strings), FM electric piano,
    Wurli, clav, drawbar, rock and church organs, harpsichord.
  - Mallets (8): marimba, vibraphone, glockenspiel, kalimba, steel drum,
    music box, tubular and church bells (bars' and bells' own modes).
  - Plucks (6): synth and bell plucks, harp, koto, nylon guitar, pizzicato.
    Plucked strings weight their harmonics by where they're plucked.
  - Leads (6), pads (6; the choir is a saw through parallel "ah" formants),
    strings (2), brass (2), winds (3).
  - FX (8): riser, downlifter, impact, noise sweep, zap, laser, wind, sub drop.
- **Kits**: Acoustic, 808, Electronic, Lo-Fi and Hard, each covering GM notes 35-81.

## Strudel names

AI dictation writes Strudel patterns; `src/library/strudel.ts` says what
they play. Drum names (`bd sd rim cp hh oh lt mt ht cr rd cb sh tb perc`)
are pads on a kit chosen by `.bank()` (808 by default, 909 for an
electronic kit); synth and instrument names (`sawtooth`, `piano`,
`gm_epiano1`, `strings`, …) are library sounds, and a note with no name
plays Strudel's default triangle. `strudelParts(haps)` turns an evaluated
cycle into parts (a kit, a sound per name) with their notes; names the
library has nothing for are reported, not guessed. The orchestrator's
dictation prompt lists exactly these names (a test keeps them in step).

## Resynthesis

`resynthesize(samples, sampleRate)` runs the renderer backwards: any
recording becomes a recipe. A short-time Fourier transform finds the
spectral peaks in each frame; peaks are tracked from frame to frame into
partials (frequency, level, attack, decay); what the partials don't explain
becomes bands of noise with their own envelopes. Notes that hold sustain for
as long as the recording held them and release as it did. A recording with a
pitch (periodic at its YIN estimate) comes back as a pitched sound rooted at
its note, playable across the keys.

`spectralDistance(a, b, sampleRate)` says how close it got: the mean
difference in dB between two spectrograms. Round trips of library sounds
come back within about 1 dB for mallets and bells, 2-3 dB for the kick, sub,
organ, harp and piano, 5-8 dB for noisy hits, and 10-15 dB for unison pads,
whose beating voices one partial per harmonic can't hold.

Rendering is deterministic: the same recipe, note, velocity and gate give the
same samples (noise is seeded from the recipe's id and `seed`). Sounds are
normalized to sound equally loud: the loudest 100 ms, K-weighted as in
BS.1770, at -12 LUFS, with peaks at most -1 dBFS (short hits stop at their
peak, a little quieter, as they sound). It's measured at the root note;
`gain` trims a recipe from there.

## Tests

```sh
npm test --workspace=packages/sound       # node --test, no build step
npm run typecheck --workspace=packages/sound
```

Nothing in CI can listen, so the tests measure (`src/analysis.ts`): the pitch
of each note, harmonic levels, aliasing, envelope times, noise bands, FM
sidebands, panning, loudness and determinism. Every library sound is checked
too: clean samples, the library loudness, no DC, one-shots ending on their
own, velocity, and its character (kicks low, hats bright, snares with wires,
toms rising); pitched sounds repeat at the period of the note played (and not
at half of it) an octave either side of their root and stay unclipped two
octaves either side; and every kit covers the GM drum map.
