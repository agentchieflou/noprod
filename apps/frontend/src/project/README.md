# Project files and storage

| File | What |
|---|---|
| `format.ts` | The `.noprod` container: writes v2, reads v2 and v1. Pure, so the worker and Node's tests both run it |
| `schema.ts` | project.json: the checks run on every load, and the migrations from earlier versions |
| `projectWorker.ts` | The worker that writes and reads files and keeps the autosave slots in IndexedDB |
| `projectFile.ts` | Main-thread side: store state to project.json and buffers, and back |
| `autosave.ts` | Autosave slots, one per tab and project, and recovery |
| `storage.ts` | Storage failures shown to the user; `navigator.storage.persist()` |

Tests: `apps/frontend/test/projectFile.test.ts` (round trips, an hour of
audio, v1 files, hostile files) and the `project` browser suite (autosave,
recovery, two tabs, a full disk, My Sounds export and import).

## The `.noprod` file, v2

v1 was one gzipped JSON string with every sample in base64. Chrome caps a
string at about 512M characters, so saves failed past roughly 15 minutes of
stereo audio. v2 keeps the samples out of strings: a small header, then
chunks, with project.json in one and the audio as raw PCM in the rest.

All integers are little-endian. A u64 is two u32s, low half first; a reader
refuses values of 2^53 or more.

### Header (16 bytes)

| Offset | Size | Value |
|---|---|---|
| 0 | 8 | `89 4E 50 52 4A 0D 0A 1A` (`\x89NPRJ\r\n\x1a`). The first byte isn't ASCII, and the line endings catch a text-mode transfer, as in PNG's signature |
| 8 | 4 | container version, u32: `1` |
| 12 | 4 | reserved: `0` |

### Chunks

Each chunk is a 16-byte header and then its payload:

| Offset | Size | Value |
|---|---|---|
| 0 | 4 | tag, 4 ASCII characters |
| 4 | 4 | flags, u32: `0`, except as below |
| 8 | 8 | payload length in bytes, u64 |

| Tag | Payload |
|---|---|
| `JSON` | project.json as UTF-8: gzip'd when flag bit 0 is set, plain otherwise (browsers without `CompressionStream` write it plain). Exactly one, before any `PCM `. A reader refuses other flag bits, and says so if it can't decompress |
| `PCM ` | u32 buffer index (into project.json's `buffers`), u32 channel, u64 first frame, then that many Float32 samples. Each chunk holds at most 2^22 frames; the writer uses 2^20 (4 MB) |
| `END ` | Empty. Always last. A file without it is truncated |

A channel's chunks come in order: each starts at the frame where the one
before it ended, and together they fill the buffer's `length` exactly.

Tags whose first letter is lowercase are optional, and readers skip ones
they don't know. A reader refuses any other unknown tag, which means the file
needs a newer NoProd. This lets a later version add data that older readers
can ignore.

### project.json

```json
{
  "format": "noprod-project",
  "version": 2,
  "savedAt": "2026-10-17T12:00:00.000Z",
  "buffers": [{ "id": "…", "sampleRate": 48000, "length": 144000, "channels": 2 }],
  "project": { "bpm": 120, "tracks": [], "regions": [], "…": "…" }
}
```

`project` is the store's project slice: every key of `createDefaultProject()`
(`PROJECT_KEYS`). An AudioBuffer anywhere in it (a clip, a session clip, a
take, a frozen track) is written as `{ "$audioBuffer": "<id>" }`. Buffers used
in several places appear once. Entry *i* of `buffers` is the buffer whose
samples are in the `PCM ` chunks with index *i*.

`version` is the schema version, separate from the container's. v1 files are
JSON, gzip'd (they start `1F 8B`) or, from browsers without `CompressionStream`,
plain (they start `{`), with `version: 1` and
`buffers: { [id]: { sampleRate, length, channels: [base64 Float32] } }`. The
reader turns them into the v2 shape and then migrates them like any other
older doc.

### Loading: refuse, never half-load

`readProjectFile` either returns a complete, checked project or throws a
`ProjectFileError` whose message says what is wrong and where (for example
`project.tracks[2].type: unexpected value "video"`). Nothing reaches the
store until the whole file has passed. In order, it:

1. checks the signature and version (a newer container or schema asks for a
   newer NoProd);
2. reads chunk headers: no length past the end of the file, and the file must
   end with `END `;
3. decompresses project.json if it is gzip'd, stopping at 256 MB (a gzip bomb);
4. migrates it to the current schema version and checks it (`schema.ts`).
   Only the schema's keys go on to the store; anything else in `project` is
   dropped;
5. checks that the samples `buffers` declares fit in the file, before it
   allocates anything. A file declaring 2^31 frames in 200 bytes is refused
   at this step;
6. checks every `PCM ` chunk: a declared buffer, a channel it has, and the
   next frame in order. Then it checks that every channel came out full.

### Changing the schema

1. Bump `SCHEMA_VERSION` in `schema.ts`.
2. Add `MIGRATIONS[old]`, which turns a doc at the old version into one at the
   new version. Migrations run one after another, so every earlier file keeps
   loading.
3. Update the checks in `projectChecks`. The tests require the schema's keys
   to match the store's `PROJECT_KEYS`, so a new project key can't be left
   unchecked. A new key needs a migration that gives older files its default.
4. Add a test that loads a file at the old version.

v1 → v2 adds `scenes`, `launchQuantization` and `midiMappings`, which v1 files
written before those existed don't have, from the store's defaults.

v2 → v3 lets a native device (one GhostDAW hosts, `native/trackBridge.ts`)
carry `state`: its plug-in's whole state as GhostDAW gives it, base64, so
what no parameter sets survives a save. It is capped at GhostDAW's own limit
on a chunk (`NATIVE_STATE_LIMIT`, 2 MiB decoded); a bigger or malformed one
is refused, naming the device. v2 files have none, so the migration only
bumps the version.

## Autosave and recovery

- **One slot per tab and project.** Slots are keyed `${tabId}:${projectId}`.
  A tab's id lives in sessionStorage, so it survives a reload, and the tab
  holds it as a Web Lock while it is open. A duplicated tab copies
  sessionStorage, finds the lock taken, and picks a new id. New, Open and
  Restore start a new project id.
- **Off the main thread.** The worker writes the slot. The main thread
  stringifies the project, which holds no audio, and copies only buffers the
  slot doesn't have yet. Each AudioBuffer keeps one id for the session, so a
  long recording is written once rather than on every autosave. The slot and
  its buffers are written in one IndexedDB transaction, and buffers the
  project no longer uses are dropped in the same transaction.
- **While playing too.** Autosave runs 1.5 s after edits pause, and at least
  every 10 s while they don't stop. A take reaches the project when
  recording stops, and the next autosave keeps it. A tab going hidden saves
  what it has.
- **Recovery.** On start, the app offers the slots of tabs that are no longer
  open (their lock is free), and this tab's own slot after a reload. The
  single recovery copy an older NoProd kept is offered once. A restored copy
  moves into this tab's slot. Saving, New and Open drop the current slot.

IndexedDB `noprod` v2 holds three stores: `slots` (project.json and its
metadata), `pcm` (`[slotKey, bufferId]` → `{ sampleRate, channels }`) and
`autosave` (v1's single copy).

## Storage failures

Autosave, My Sounds and the plug-in list report failures to `storage.ts`
instead of swallowing them. The File menu shows the latest one, for example
"Autosave: browser storage is full". It covers quota exceeded, storage
unavailable (a private window, or blocked site data) and other write errors.
A store that writes successfully again clears its own notice. After the
first autosave or My Sounds save that succeeds, the app asks once for
`navigator.storage.persist()`, so Safari won't evict the data after a week
without a visit.

My Sounds (IndexedDB `noprod-sounds` v2) stores
`{ id, version: SOUNDS_VERSION, recipe }`. The upgrade from v1 wraps the bare
recipes v1 stored. The File menu exports them as
`{ format: "noprod-sounds", version, sounds }` and imports such a file. An
import is refused whole if any sound is malformed, and an imported sound
never takes a built-in sound's id.

## Saving outside Chromium

Without the File System Access API (Firefox, Safari), Save and Save As are
labelled "(download)". They download `<project name>.noprod` and say that each
Save is a new download.
