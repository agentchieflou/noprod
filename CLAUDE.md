# noprod: notes for coding agents

A DAW in the browser, plus a native audio host. Sounds are built from
scratch (arrangements of frequencies, or physical models), and a keyboard
coach teaches as you play.

## Where things are

| Path | What |
|---|---|
| `apps/frontend` | The DAW: React 19, Vite, TypeScript. Zustand store in `src/store/useDAWStore.js`; Web Audio engine in `src/audio/`; UI in `src/components/` |
| `apps/orchestrator` | WebSocket hub on 8080: AI dictation (Gemini → Strudel code), relays to the sequencer and audio core |
| `apps/sequencer` | Headless Strudel (Puppeteer) on 8081 |
| `apps/audio_core` | GhostDAW: C++/JUCE host for LPI and VST3 plugins on 8082 (see its README) |
| `packages/sound` | `@noprod/sound`: sound recipes and their renderer, the library, physical models (`model.ts`), DSP chains (`chain.ts`), resynthesis. See its README |
| `packages/theory` | `@noprod/theory`: keys, chords, voice leading, the Keyboard Coach. See its README |
| `packages/shared` | WebSocket message types |

The plugins themselves (LPI ABI, the cuif UI framework, Reverb, EQ-8…) live
in the sibling repo `agentchieflou/v-loudio-t`.

Frontend landmarks: `App.tsx` (layout, bottom-panel tabs), `audio/engine.ts`
(strips, master), `audio/library.ts` (library instruments, render workers),
`audio/inputs.ts` (`onMidiEvent`: every note source), `audio/computerKeyboard.ts`,
`components/KeyboardPanel.tsx`, `SoundDesigner.tsx`, `DspMap.tsx`.

## Commands

```sh
npm test                                   # packages/sound and packages/theory
cd packages/sound && ../../node_modules/.bin/tsc -p .     # typecheck a package
cd apps/frontend && npx tsc -b && npx oxlint src && npx vite build
npm run e2e                                # every browser suite (about 2 minutes)
npm run e2e -- designer dspmap             # some of them
E2E_SKIP=dictation npm run e2e             # without the one that needs unpkg
```

- Packages run as TypeScript directly (Node 22.18+ strips types): imports
  carry `.ts` extensions, and nothing that needs compiling (no enums,
  namespaces or parameter properties).
- oxlint: the one accepted warning is PianoRoll's `exhaustive-deps`. A
  `.tsx` file exports only components (`only-export-components`); helpers and
  constants go in a `.ts` file beside it.
- A Vite dev server you started yourself must be restarted after you edit
  source files and before you run browser checks against it: hot reloads
  leave duplicate modules that break the tests' dynamic imports.
- Stop processes you started by their PID. Never use `pkill -f`: it matches
  other sessions' processes too.

## Tests

Nothing in CI can listen, so tests measure: pitch, levels, spectra,
envelopes, determinism (`packages/sound/src/analysis.ts`).

- Every library sound must pass `packages/sound/test/library.test.ts`. That
  means:
  - the library loudness (−12 LUFS, peaks at most −1 dBFS);
  - in tune an octave either side of its root;
  - unclipped two octaves either side;
  - quieter at lower velocity.
- Browser suites live in `apps/frontend/e2e/suites/<name>.cjs`. Each one is
  `module.exports = async (page, ctx) => {}` and prints one `PASS …` or
  `FAIL …` line per check.
  - `ctx` gives `sleep`, `logs`, `fixtures`, `shotDir` and `shot(name)`.
  - App state is at `window.__dawStore.getState()`. The transport is at
    `window.__transport`; use `masterAnalyser` to check that something is
    audible.
  - In the page, import the repo's packages with
    `await import(window.__fs + '/packages/sound/src/index.ts')`.
  - End with a "No page errors" check that ignores `ws://localhost:8080`.
  - Look at what you built: `ctx.shot('name')` writes
    `apps/frontend/e2e/.shots/name.png`.
- A bug fix comes with a test that fails on the old code. Check this: put
  the old code back, see the test fail, then restore it.

## Conventions

- Write code that reads like the code around it. Comments are short and say
  why; names and idioms match the file you're in. Don't add dependencies
  without a reason.
- A user's edits go through store actions (`updateInstrumentParameter`,
  `setTrackInstrument`, …) so they can be undone and are saved with the
  project.
- One topic per commit, with a descriptive subject. The body says why.
- Pull requests are squash-merged. The body lists what changed and the
  evidence: test counts, suites run.

## Work tiers

Roadmap issues carry a tier label: `tier:haiku`, `tier:sonnet` or
`tier:opus` (see #90). Keep to the issue's scope. If it turns
out to need more, comment on the issue and stop rather than widening the
change. "More" means a design decision, a change to a package's public API,
or files well beyond those the issue names.
