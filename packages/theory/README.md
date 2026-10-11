# @noprod/theory

noprod's music theory engine: keys, chords, voice leading, and the
**Keyboard Coach** that lights up the keys to play next. Pure TypeScript, no
dependencies, no DOM: the DAW's keyboard feeds it notes and draws what it
returns. MIDI 60 is C4; a pitch class is a pitch without its octave (C = 0).

```ts
import { Coach } from '@noprod/theory';

const coach = new Coach({ mode: 'chords', key: 'auto', range: [48, 84] });
coach.noteOn(60, 0); coach.noteOn(64, 0); coach.noteOn(67, 0);
const { highlights, readout } = coach.suggest();
// readout.message: 'C (I) → try G (V) or F (IV)'
// highlights: each next chord voice-led from C, one group per chord
```

## Modules

| Module | What it does |
|---|---|
| `notes.ts` | Pitch classes and note names (`noteName(63, true)` is `'Eb4'`) |
| `scales.ts` | Scales, keys (`{ tonic, mode }`), their names, degrees and spelling |
| `chords.ts` | 18 chord types, names (`'Am/C'`), Roman numerals (`'V7'`, `'bVII'`), recognizing a chord from held notes |
| `keys.ts` | `findKey` over a pitch-class histogram; `KeyTracker` for the key of what's being played now |
| `harmony.ts` | `PROGRESSIONS` and `nextChords`: which chord comes next |
| `voicing.ts` | `voiceLead`: the next chord with the least hand movement |
| `melody.ts` | A corpus of public-domain tunes and `nextNotes`: which note comes next |
| `complement.ts` | `complements`: what to add to the notes held |
| `lessons.ts` | Chord and melody lessons, and `LessonRunner` to follow one |
| `coach.ts` | `Coach`: tracks held notes, the melody, chords and key; returns highlights and a readout |
| `accompany.ts` | `ACCOMPANY_STYLES` and `Accompanist`: a bass line and comping that follow the chords played |

## The models

- **Chord recognition** tries every root and type against the held pitch
  classes (any voicing, inversion or doubling): first a chord that explains
  every note, then one missing as few of its own as possible, then the
  smallest (a triad before a 7th); ties go to the chord with its root in the
  bass, then to the one in the key. Two notes a 5th apart are a power chord;
  other pairs are the likeliest triad, with low confidence.
- **Key finding** is Krumhansl-Schmuckler: correlate a pitch-class
  histogram with the Krumhansl-Kessler profiles of all 24 keys. The tracker's
  histogram fades (half-life 8 s), counts long notes more, and only changes
  key when another fits clearly better. When several keys fit about as well
  (C, G/B, Am fit C major, E minor and G major), the coach takes the one
  whose home chord was played first: progressions usually start at home.
- **Next chords** add three votes: functional harmony (45%, a table of where
  each chord of the key goes: V to I, ii to V...), progressions (45%, every
  place a known progression ends the way the last chords did; the chord
  after it gets length² votes) and how common each chord is (10%). The
  chord just played is never suggested, going straight back is discounted,
  and 7ths stay 7ths (ii7, V7, Imaj7; the blues' dominant 7ths).
- **Voice leading** tries every inversion and octave within an octave of
  the last voicing and keeps the one that moves the fewest semitones (voices
  paired bass to bass; split or merged when the counts differ), hand-sized
  and compact.
- **Next notes** multiply degree bigram and trigram odds from the corpus
  (add-one smoothed; tunes in the same mode count three times) by an interval
  prior (repeats and steps likely, leaps rare), a recovery after a leap of a
  4th or more (a step back the other way), tendency tones (7 to 1, 4 to 3, 2
  to 1) and the chord's notes. Candidates are the key's notes within an
  octave.
- **Complements**: two notes get the notes completing the key's chords that
  hold them, weighted by how common those chords are; a triad gets its 7th,
  9th and 6th (outside the key, much less); one note gets the key's 3rds and
  6ths above and below.

Every list of suggestions is sorted, its weights sum to 1, and it's
deterministic: the same notes give the same suggestions.

## The accompaniment

The coach's band: a bass and a keys part that follow the chords you play.
A style is data, one bar of hits, each a bass tone (`'root'`, `'third'`,
`'fifth'`, `'sixth'`, `'seventh'`, `'octave'`) or the keys' `'chord'`, at a
beat with a length and a velocity. Its `step` is how often the chord may
change (a beat in Pop eighths; half a bar in Ballad and 12-bar shuffle), and
`color` how it plays chords (the shuffle plays C as C7). The keys are
voice-led with `voiceLead` (E3 to E5), and the bass takes the root nearest
the last one (E1 to G2, the tones above it up to G3).

```ts
const band = new Accompanist(findStyle('ballad')!);
band.noteOn(60, 3.9); band.noteOn(64, 3.9); band.noteOn(67, 3.9);  // C, at 3.9 beats
band.advance(now, now + lookahead);   // [{ type: 'start', note: { part, pitch, start, end, velocity } }, ...]
```

- **Which chord.** A step plays the chord held at its start; if nothing is
  held, the last chord put down. A chord is three or more pitch classes, and
  only a key pressed changes it: lifting a chord note by note doesn't.
- **Timing.** Everything is in beats from a clock the caller drives:
  `advance(now, until)` commits the notes starting before `until`. A chord
  put down before a step catches it, even when the step's notes are
  committed: `noteOn` returns `stop` events for the notes it undoes, and the
  new ones. Up to a 32nd note (`LATE_GRACE`) after a step's start it still
  takes the step: the step is struck again with it, at once. Later, it waits
  for the next step. It never guesses ahead (playing the coach's suggestion
  for a late change): what you play leads.
- **Sustained notes.** A hit across a step where the chord changes stops
  the notes the new chord doesn't have and strikes the ones it adds; a
  common note holds on. A change taken back before its step leaves the chord
  sounding (struck again there, if its stop was already sent).
- `stop(now)` ends every note then. Same notes and times in, same notes out.

In the DAW (`apps/frontend/src/audio/accompany.ts`), Accompany in the
coach's Chords mode starts the transport and plays on two tracks, Band
Bass (a finger bass) and Band Keys (an electric piano), made the first time
and reused after, so their strips, devices and sends apply. A chord counts
from 30 ms after it's played (what's sooner may already be rendering), so
one put down a 16th before a downbeat catches it.

## The corpus

Twinkle Twinkle Little Star, Ode to Joy, Frère Jacques, Mary Had a Little
Lamb, Amazing Grace, Greensleeves, When the Saints Go Marching In,
Scarborough Fair, London Bridge and Row Row Row Your Boat: traditional
tunes and Beethoven's theme, all in the public domain, written as note
names in their keys.

## Tests

```sh
npm test --workspace=packages/theory       # node --test, no build step
npm run typecheck --workspace=packages/theory
```
