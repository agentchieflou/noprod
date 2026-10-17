# Contributing to noprod

noprod is a DAW in the browser, plus a native audio host. The short version of
how to work here is below. [CLAUDE.md](CLAUDE.md) has the full notes on the
layout, conventions and tests; it is written for coding agents, but it is the
most complete reference we have.

## Setup

You need Node 22.18 or later. Then, from the repository root:

```sh
npm ci
```

## Commands

```sh
npm test                                   # packages/sound and packages/theory
cd packages/sound && ../../node_modules/.bin/tsc -p .     # typecheck a package
cd apps/frontend && npx tsc -b && npx oxlint src && npx vite build
npm run e2e                                # every browser suite (about 2 minutes)
npm run e2e -- designer dspmap             # some of them
E2E_SKIP=dictation npm run e2e             # without the one that needs unpkg
```

Packages run as TypeScript directly, so imports carry `.ts` extensions and
nothing in them may need compiling (no enums, namespaces or parameter
properties).

Lint has one accepted warning: PianoRoll's `exhaustive-deps`. A `.tsx` file
exports only components. Put helpers and constants in a `.ts` file beside it.

If you run a Vite dev server, restart it after you edit source files before you
run browser tests against it. Hot reloads leave duplicate modules that break the
tests' dynamic imports.

## Tests

The tests measure pitch, levels, spectra, envelopes and determinism. They do not
listen. See `packages/sound/src/analysis.ts`.

- Every library sound must pass `packages/sound/test/library.test.ts`. It checks
  the loudness (−12 LUFS, peaks at most −1 dBFS), that the sound is in tune an
  octave either side of its root, that it is unclipped two octaves either side,
  and that it is quieter at lower velocity.
- `packages/sound/test/renders.test.ts` checks that every library sound renders
  bit for bit as fingerprinted in `test/renders.json`. An engine change must not
  move them. If you change a sound on purpose, regenerate the fingerprints with
  `node test/renders.ts --write` in `packages/sound`, and say why in the PR.
- Browser suites live in `apps/frontend/e2e/suites/`. Each one prints a `PASS`
  or `FAIL` line per check, and ends with a "No page errors" check.
- A bug fix comes with a test that fails on the old code. Check it: put the old
  code back, see the test fail, then restore the fix.

## Conventions

- Write code that reads like the code around it. Keep comments short, and say
  why rather than what.
- A user's edits go through the store actions, so they can be undone and are
  saved with the project.
- One topic per commit, with a descriptive subject. The body says why.
- Pull requests are squash-merged. The PR body lists what changed and the
  evidence: test counts and the suites run.

## License

noprod is licensed under the [Apache License 2.0](LICENSE). By contributing,
you agree that your contributions are licensed under it too.

## Dependencies

We own what we ship. Nothing restricted by its license goes into the apps, the
packages, GhostDAW or the plugins. That covers copyleft licenses (GPL, AGPL,
LGPL, MPL, EPL and the like), source-available licenses, and paid licenses.
Permissive licenses are fine: MIT, BSD, Apache-2.0, ISC, Zlib, MIT-0, CC0 and
public domain.

Before you add a dependency, check its license and the licenses of everything it
pulls in, and name them in the PR. Development tools that never ship, such as
the test runner and linters, may use any license that allows our use of them.

If a dependency is restricted, we rebuild what it does in this repo rather than
ship it. Work from documentation, specifications and observed behavior. Do not
read or copy the restricted project's source.

Still to rebuild: Strudel (AGPL; the sequencer and AI dictation) and JUCE (GhostDAW).
