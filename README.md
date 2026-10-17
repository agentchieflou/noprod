# noprod

noprod is a digital audio workstation (DAW) that runs in the browser. Its
sounds are built from scratch, from spectral recipes (arrangements of
frequencies) or from physical models of instruments. Type a description and
AI dictation writes it as a [Strudel](https://strudel.cc) pattern. A keyboard
coach teaches chords and progressions as you play. GhostDAW, a native host
in `apps/audio_core`, runs LPI and VST3 plugins alongside the browser's own
tracks. The plugins live in the sibling repo
[v-loudio-t](https://github.com/agentchieflou/v-loudio-t).

## Quick start

You need Node 22.18 or newer.

```sh
npm install

npm run start:frontend      # the DAW, at http://localhost:5173
npm run start:orchestrator  # WebSocket hub, on port 8080
```

Run each command in its own terminal, then open http://localhost:5173.

- The frontend works on its own. The orchestrator gives dictation: it asks
  Gemini for pattern code, checks it with our own pattern engine
  (`packages/pattern`), and the DAW plays it in the browser.
- The orchestrator needs a Gemini key for dictation. Copy
  `apps/orchestrator/.env.example` to `apps/orchestrator/.env` and set
  `GEMINI_API_KEY`.
- GhostDAW (`ws://localhost:8082`) is optional. It hosts plugins. Build it
  from [apps/audio_core/README.md](apps/audio_core/README.md), which covers
  its JUCE submodule and its platform packages.

## Layout

| Path | What it is |
|---|---|
| `apps/frontend` | The DAW: React, Vite and TypeScript |
| `apps/orchestrator` | WebSocket hub on 8080: dictation (Gemini to pattern code, checked with `@noprod/pattern`), relays to GhostDAW |
| `apps/audio_core` | GhostDAW: a C++/JUCE host for LPI and VST3 plugins, on 8082 |
| `packages/sound` | `@noprod/sound`: sound recipes, the renderer, the library and physical models |
| `packages/theory` | `@noprod/theory`: keys, chords, voice leading and the Keyboard Coach |
| `packages/pattern` | `@noprod/pattern`: the pattern engine behind dictation (cycles, events, the mini-notation and its functions) |
| `packages/shared` | WebSocket message types shared by the apps |

## Tests

```sh
npm test       # unit tests for packages/sound and packages/theory
npm run e2e    # browser suites, about two minutes
```

`npm run e2e` starts the frontend itself and runs each suite in a headless
Chromium. It takes `CHROME_PATH` for a browser of your own. Name suites to
run a few, or skip some:

```sh
npm run e2e -- designer dspmap
E2E_SKIP=dictation npm run e2e
```

The frontend also has its own checks:

```sh
cd apps/frontend && npx tsc -b && npx oxlint src && npx vite build
```

CI runs these from `.github/workflows/`:

- `ci.yml`: the package tests and typecheck, the frontend types, lint and
  build, and the browser suites;
- `audio-core.yml`: builds GhostDAW and runs its tests, when
  `apps/audio_core` changes.

## More

- [CLAUDE.md](CLAUDE.md): how the codebase works, its conventions and the
  commands behind these checks
- [packages/sound/README.md](packages/sound/README.md): sound recipes, the
  renderer and the library
- [packages/theory/README.md](packages/theory/README.md): keys, chords and
  the Keyboard Coach
- [apps/audio_core/README.md](apps/audio_core/README.md): building and
  testing GhostDAW

## License

noprod is open source under the [Apache License 2.0](LICENSE). One part
still uses code under another license until it's rebuilt: GhostDAW (JUCE).
See #147.
