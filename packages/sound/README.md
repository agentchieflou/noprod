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
   `tonehole`, `damping` (H(z) = (1 − a)/(1 − a·z⁻¹)). `parallel` radiators
   each take the resonator's sound on a path of their own, beside the
   series ones, and the paths are mixed at the end (a body and a bell at
   once; a sitar's two gourds).

A string can share its bridge with more strings (`strings`, #108): a
`unison` course, played with it (a piano's three strings to a note, tuned
a cent or so apart in `cents`), or `sympathetic` strings no one plays,
tuned in cents from the note or to fixed `notes` (a sitar's taraf). The
bridge moves with all of them and sends each string's wave back plus its
own motion: the scattering S = α(z)·11ᵀ − I, with α = 2ρ/(1 + Nρ) and ρ the
string's impedance over the bridge's (`coupling`), α(z) a one-pole
low-pass. Its eigenvalues are −1 (the strings moving against each other)
and α(z)·N − 1 (all together, moving the bridge), so |S| ≤ 1 whatever ρ:
the coupling never adds energy. What moves the bridge is lost to it, so a
course dies fast, then slowly, and beats; a sympathetic string rings when
the note shares its partials. With strings at the bridge, the envelope of a
plucked or struck string damps it in the loop, so the sympathetic strings
ring on after it's let go. `buzz` lays the string along a curved bridge (a
sitar's jawari): it is shorter on one side of each swing, and buzzes.

The layer's envelope is the player's input: bow speed or breath pressure for
the closed-loop exciters, a damper for plucks and strikes. Loop lengths are
corrected for the phase delay of the filters in them, and closed-loop models
(whose lips, jets and reeds settle a little off the loop's pitch) are tuned
by a short probe note, measured and corrected, cached per configuration. As
the note plays they are also tuned by ear, as a player would: once a period
the model finds where the sound repeats and nudges the loop toward the
note, so the attack is in tune too (within 5 cents from when it speaks).

A rendered note of a model layer runs a `ModelLayerVoice` from start to
end: the layer's envelope, glide and vibrato, its model (`ModelVoice`), its
filters, its ring-out, tremolo, drive and pan, a sample at a time. A
`LiveNote` runs the same voices for a note played live (#106): for as long
as the key is held, then `release()`, and it rings out by its own physics.
It follows the player as it plays: `slur(note)` (legato: the same voice, no
new attack) and `control(to, value)`, smoothed: the player's `input` to a
bow or breath, added `vibrato`, a `bend`. `LIVE_CONTROLS` maps MIDI to
these, as data: breath (CC2), expression (CC11) and aftertouch move the
input, the mod wheel (CC1) adds up to 40 cents of vibrato, and the pitch
bend is ±2 semitones; `liveControl(event)` applies it. Let
go where a rendered note's gate is, a live note plays that note to the bit.
`playsLive(recipe)` says which sounds can (pitched, all model layers), and
`legato(recipe)` which slur (by default, lips, jets and reeds).
`liveTunings` measures a note's closed-loop tunings, to compute off the
audio thread and pass in. Playing a voice allocates nothing.

Any block of any layer can be switched off without losing its settings:
`bypass: ['radiator:0', 'filter:1', 'drive', …]`.

### Chains

`chainOf(recipe)` (`src/chain.ts`) describes every layer of any recipe as
blocks across five stages, the same for a synth lead as for a violin:

| Stage | Blocks (ids) |
|---|---|
| Player input | `env`, `pitch`, `vibrato` |
| Excitation | `exciter` (pluck, strike, bow, lips, jet, reed) or `source` (partials, wave, fm, noise) |
| Resonator | `resonator` (string, bore); `strings:N` (unison, sympathetic), branches beside it |
| Radiator | `radiator:N` (body, helmholtz, bell, tonehole, damping), `parallel:N` (branches beside them), then `filter:N` |
| Output | `tremolo`, `drive`, `mix` (level and pan) |

Each block has its kind, family, label, whether it's on, whether it's in
a closed loop with the resonator, and its branch: 0 on the chain itself, 1,
2… for the paths beside it in its stage. `BLOCKS` catalogues every kind (label,
description, stage, defaults, the layer types it fits). The edits return new
recipes:

```ts
setBlockOn(recipe, 0, 'radiator:0', false);  // switch a block off (settings kept)
setKindOn(recipe, 'vibrato', false);         // every block of a kind
branchesFor(recipe, 0, 'radiator');          // what can be added: ['helmholtz', 'bell', …]
addBlock(recipe, 0, 'bell');                 // a radiator or filter in series; an exciter or
                                             // resonator swaps the model's; a source adds a layer
addBlock(recipe, 0, 'sympathetic');          // strings at the string's bridge (a branch)
addBlock(recipe, 0, 'bell', { parallel: true }); // a radiator beside the series ones (a branch);
                                             // branchesFor(…, { parallel: true }) lists them
setBlockOn(recipe, 0, 'strings:0', false);   // a branch switches off as a whole
removeBlock(recipe, 0, 'radiator:0');        // later blocks (and their bypasses) renumber
sharedBlocks([violin, guitar, lead]);        // the kinds two or more of them have, by stage
```

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
- **Modeled** (`src/library/modeled.ts`): 16 physical models, tagged `modeled`,
  in their usual categories.
  - Bowed (bow, string, body): violin, viola, cello, double bass.
  - Brass (lips, flared bore, bell): trumpet, trombone, French horn.
  - Winds: flute and recorder (air jet, open bore, toneholes), clarinet
    (reed, cylindrical bore: its odd harmonics).
  - Plucked (pluck, string, body and air cavity): nylon and steel guitars,
    harp, banjo, pizzicato violin.
  - Struck: hammered dulcimer (courses of two strings, a few cents apart).
  Bowed and blown ones sustain while the note is held and ring out when it
  ends; plucked and struck ones ring down on their own.
- **Kits**: Acoustic, 808, Electronic, Lo-Fi and Hard, each covering GM notes 35-81.

## Strudel names

AI dictation writes patterns in Strudel's language, which `@noprod/pattern`
plays (#133); `src/library/strudel.ts` says what the names mean. Drum names (`bd sd rim cp hh oh lt mt ht cr rd cb sh tb perc`)
are pads on a kit chosen by `.bank()` (808 by default, 909 for an
electronic kit); synth and instrument names (`sawtooth`, `piano`,
`gm_epiano1`, `strings`, …) are library sounds, and a note with no name
plays the default triangle. `strudelParts(haps)` turns an evaluated
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

## Time-stretch and pitch-shift

`stretch(channels, { sampleRate, ratio, semitones, formants, mode })`
(`src/stretch.ts`) makes any audio `ratio` times as long without changing
its pitch, or shifts its pitch by `semitones` without changing its length,
or both. It's a phase vocoder, built from the papers:

- **Identity phase locking** (Laroche & Dolson, 1999). Each spectral peak's
  phase advances by its measured frequency; the bins around it keep their
  analysed phase relative to it, so a partial's whole lobe turns as one and
  tones stay clean. A sine stretched ×0.5 to ×2, or shifted an octave
  either way, comes out at its pitch to a thousandth of a cent.
- **Transients** (after Röbel). Onsets are found ahead of the frames by
  spectral flux, and placed to a millisecond. The frames that see an onset
  are read at the hop they're written at, with their analysed phases (a
  phase reset), so they put the attack back sample for sample. The frames
  before it are steered so the attack lands exactly where the ratio puts
  it, and the time not stretched there is made up between onsets.
- **Pitch shift** is a stretch by the pitch factor, then a windowed-sinc
  resample. `formants: true` keeps the spectral envelope where it was: a
  line through each frame's spectral peaks, smoothed by liftering its
  cepstrum, moved back after the shift. A voice shifted up keeps its vowels.
- **Stereo.** Every channel turns by the same rotation per bin, measured on
  the channels' sum (or their difference, where they cancel), so the phase
  and level differences between them, the image, are kept exactly.

| Mode | Like Live's | Frame | Onsets |
|---|---|---|---|
| `complex` (default) | Complex Pro | 85 ms | found and kept |
| `beats` | Beats | 43 ms | found more keenly |
| `tones` | Tones | 170 ms | ignored |

It's deterministic, and works block by block for an AudioWorklet:

```ts
const s = new Stretcher(2, { sampleRate: 48000, ratio: 1.25 });
s.write([left, right]);           // any block size
s.read([outLeft, outRight]);      // returns how many samples were ready
s.end();                          // no more input: the rest comes out
```

`s.latency` is how much input must arrive before output starts. Stereo
48 kHz runs at about 25× realtime in Node (the tests print the numbers).

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
