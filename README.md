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
npm run start:sequencer     # headless Strudel, on port 8081
```

Run each command in its own terminal, then open http://localhost:5173.

- The frontend works on its own. The other two give dictation: the
  orchestrator asks Gemini for Strudel code, and the sequencer turns it into
  notes.
- The orchestrator needs a Gemini key for dictation. Copy
  `apps/orchestrator/.env.example` to `apps/orchestrator/.env` and set
  `GEMINI_API_KEY`.
- The sequencer loads Strudel from unpkg.com, so it needs network access.
- GhostDAW (`ws://localhost:8082`) is optional. It hosts plugins. Build it
  from [apps/audio_core/README.md](apps/audio_core/README.md), which covers
  its JUCE submodule and its platform packages.

## Browser support

noprod supports the **last two versions of Chrome, Edge, Firefox and Safari**
(desktop). The smoke test of the built app (`npm run e2e:dist`) runs in
Chromium, Firefox and WebKit in CI; the full suites run in Chromium.

- A browser without AudioWorklet, or a page that isn't a secure context
  (https, or localhost), gets a page saying why noprod can't run.
- Under 900 px wide, noprod shows a notice that it is built for larger
  screens, with "Continue anyway".
- Safari has no `outputLatency`: recordings are placed by the base latency
  plus an estimate you can change (VST Folders Scan tab).
- Firefox asks for its site-permission add-on before WebMIDI works, and can't
  list a plugin folder from a page, so plugin scanning is off there (add the
  folder's path for GhostDAW instead).
- Project files are gzipped; where `CompressionStream` is missing they are
  saved as plain JSON, which loads everywhere.
- The build target (`apps/frontend/vite.config.ts`) is a syntax floor below
  that policy; APIs aren't polyfilled.

## Layout

| Path | What it is |
|---|---|
| `apps/frontend` | The DAW: React, Vite and TypeScript |
| `apps/orchestrator` | WebSocket hub on 8080: dictation (Gemini to Strudel code), relays to the sequencer and GhostDAW |
| `apps/sequencer` | Headless Strudel, run with Puppeteer, on 8081 |
| `apps/audio_core` | GhostDAW: a C++/JUCE host for LPI and VST3 plugins, on 8082 |
| `packages/sound` | `@noprod/sound`: sound recipes, the renderer, the library and physical models |
| `packages/theory` | `@noprod/theory`: keys, chords, voice leading and the Keyboard Coach |
| `packages/shared` | WebSocket message types shared by the apps |

## Tests

```sh
npm test       # unit tests for packages/sound and packages/theory
npm run e2e    # browser suites, about two minutes
E2E_BROWSER=firefox npm run e2e:dist   # the built-app smoke test in Firefox (or webkit)
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

noprod is open source under the [Apache License 2.0](LICENSE). Two parts
still use code under other licenses until they're rebuilt: the sequencer in
`apps/sequencer` (Strudel, AGPL) and GhostDAW (JUCE). See #147.
