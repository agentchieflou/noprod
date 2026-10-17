# @noprod/midi

noprod's Standard MIDI File codec: `readMidiFile` and `writeMidiFile`, formats
0, 1 and 2, written from the MIDI Association's *Standard MIDI Files 1.0*
(RP-001). Pure TypeScript, no dependencies, no DOM. It returns plain data in
**beats** (float64 quarter notes, as `@noprod/time`); turning that into tracks
and clips is the store's job, not this package's.

```ts
import { readMidiFile, writeMidiFile, MidiFileError } from '@noprod/midi';

try {
  const file = readMidiFile(new Uint8Array(await blob.arrayBuffer()));
  file.tempo;            // [{ beat: 0, bpm: 120 }, ...]: feed it to TempoMap
  file.meter;            // [{ bar: 0, numerator: 4, denominator: 4 }, ...]: feed it to MeterMap
  file.tracks[1].notes;  // [{ pitch, start, length, velocity, channel, releaseVelocity? }, ...]
  file.warnings;         // what was recoverable, each said once
} catch (e) {
  if (e instanceof MidiFileError) console.log(e.message, e.offset);   // what, and at which byte
}

const bytes = writeMidiFile(file, { format: 1, ticksPerBeat: 960 });
```

## The shape

`MidiFile` is `{ format, ticksPerBeat, tempo, meter, key?, markers, tracks, warnings }`
(`src/types.ts`). One `MidiTrack` per `MTrk` chunk, in file order, so a format 1
file's track 0 (the conductor track, usually without notes) is `tracks[0]`.

- **Notes** have `pitch`, `start`, `length` (beats), `velocity` (0..1: the
  file's 1..127 over 127), the `channel` (0..15) and a `releaseVelocity` (0..1)
  only when the file ended the note with a real note-off (`8n`). A note-on of
  velocity 0 ends a note without one.
- **Controllers** and **channel pressure** keep the file's 0..127 as is;
  **programs** are 0..127; **pitch bend** is −1..1 (`(value − 8192) / 8192`
  of the 14-bit value, so the top step is 16383/8192 − 1). Polyphonic key
  pressure is read and not kept.
- Every event carries its `channel`, so a format 0 file (one track) can be
  split by channel by whoever imports it.
- **Tempo, meter, key and markers** come from every track, merged in time
  order. `tempo` is never empty and starts at beat 0 (120 BPM, the spec's
  default, when the file sets none or sets the first later); `meter` starts at
  bar 0 (4/4 likewise). `meter` is by 0-based bar, as `MeterMap` takes it;
  `tempo` is clamped to `TempoMap`'s 20–999 BPM. `key` is absent when the file
  has no Key Signature. Only Marker metas (`FF 06`) are markers; the other
  text metas are skipped. Two tempos at one tick keep the later.
- Text is UTF-8 when it decodes as such, latin-1 when it does not.
- `ticksPerBeat` is the file's division.

## Reading

Following RP-001 §2 (chunks; unknown types are skipped; a header longer than
6 bytes is skipped past), §3 (format, tracks, division) and §4 (delta times,
running status, channel events, sysex `F0`/`F7` and meta events). Running
status carries across channel events and is cancelled by sysex and meta
events. Sysex, escapes and the metas not listed above are read and skipped.

**Pairing notes.** A note-off ends the *oldest* open note of its pitch and
channel: overlapping notes pair first in, first out. The reason: with FIFO a
retriggered pitch's notes end in the order they began, so none contains
another and each stays a plain block on a piano roll; last in, first out
would make the first note outlast the second, and a note-off could never
shorten the note you meant. A note never released ends at its track's last
event; a zero-length note is one tick long.

**Chunks** are walked one at a time and only the tracks are kept: a file of
millions of empty unknown chunks costs the walk, no memory. Tracks beyond the
header's count are skipped unread, with a warning.

**Format 2** (independent patterns): every track is read from beat 0, with a
warning; tempo and meter are merged like format 1's. **SMPTE division**
(a negative high byte): ticks are seconds there, so positions convert at the
file's first tempo or 120 BPM, with a warning, and `ticksPerBeat` is the
effective ticks per beat at that tempo (not necessarily an integer). `tempo`
is then only `[{ beat: 0, bpm }]` at that tempo, whatever other Set Tempo events
the file has (they are dropped, with a warning): the positions were converted
at the first, so a `TempoMap` of later ones would put notes at the wrong second. A time
signature that falls mid-bar moves to the next bar line, with a warning.

### Warnings

Each is said once, whatever the number of occurrences: a missing End of Track;
bytes after one or after the last chunk; tracks beyond the header's count; a
format 0 file with several tracks; format 2; SMPTE division, and tempos dropped under it; a note-off with
no note-on; a note with no note-off; a mid-bar Time Signature; and a Set
Tempo, Time Signature or Key Signature that is malformed or out of range
(ignored).

### Hostile input

A file is untrusted. Every read is bounded by the chunk it is in, and nothing
is allocated from a declared length, so time and memory stay proportional to
the bytes present. Every refusal is a `MidiFileError` with the byte `offset`
and what was wrong: a chunk length past the end of the file; a variable-length
quantity longer than 4 bytes; running status with no status before it; a data
byte ≥ 0x80 where one belongs; a meta or sysex length past its chunk; an
`MThd` length under 6; 0 tracks, or more tracks declared than chunks present;
an unknown format, a division of 0, a status byte that has no place in a file.

| Limit | Value | Constant |
|---|---|---|
| The file | 64 MB | `MAX_FILE_BYTES` |
| Tracks | 1024 | `MAX_TRACKS` |
| Events, in all | 2,000,000 (the End of Track counts) | `MAX_EVENTS` |
| The song | 100,000 beats | `MAX_BEATS` |

## Writing

`writeMidiFile(file, { format?, ticksPerBeat? })` takes a `MidiFile`, or any
object with `tracks` and optionally `tempo`, `meter`, `key` and `markers`. It
writes format 1 by default, or format 0 (every track merged into one chunk)
with `{ format: 0 }`; the division is `ticksPerBeat ?? 960`. `tracks[i]` is
chunk `i`, and tempo, meter, key and markers go in chunk 0 beside `tracks[0]`.
A file always has at least one track, so an empty `tracks` writes one empty
chunk. Positions round to the nearest tick, and at one tick note-offs come
before everything else, note-ons last. Running status is used. A value a file
cannot hold throws a `RangeError`.

`read(write(x))` equals `x` when `x`'s positions are on the division's ticks,
its velocities are multiples of 1/127, its tempos are whole microseconds per
quarter (anything else is rounded, as a MIDI file has no finer unit), and no
note of a pitch and channel is contained in another of the same: a file has
only on/off pairs, so the pairing rule above reads those back first in, first
out (a note 0..4 holding one 1..3 returns as 0..3 and 1..4).

## Tests

`node --test test/*.test.ts`: every rule above, each refusal and limit (at and
past it), one file's exact bytes, round trips for formats 0 and 1 at divisions
96, 480 and 960, 2,000 seeded mutations of a valid file (each reads or throws a
`MidiFileError`, in under 50 ms), and the file's tempo against `TempoMap`.
