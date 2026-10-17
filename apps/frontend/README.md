# noprod frontend

The DAW: React 19, Vite and TypeScript, with a Web Audio engine. Sounds are
built from scratch (arrangements of frequencies, or physical models), and the
Keyboard Coach teaches as you play. See the [root README](../../README.md) and
[CLAUDE.md](../../CLAUDE.md) for the rest of the repo.

## Run

```sh
npm ci            # at the repo root
npm run dev --workspace=apps/frontend
```

## Build

```sh
cd apps/frontend
npx tsc -b && npx oxlint src && npx vite build
```

`dist/` is static and works under any path. Set `NOPROD_BASE` to the path it
is served from (default `/`):

```sh
NOPROD_BASE=/noprod/ npx vite build
```

The build has no inlined scripts. It writes sourcemaps as separate `.map`
files that the bundle doesn't reference; leave them off the server. The
version and commit shown in the top bar come from `package.json` and git.

## Test

```sh
npm run e2e                      # every suite, against the dev server
npm run e2e -- designer dspmap   # some of them
npm run e2e:dist                 # builds, serves dist under /noprod/, smoke-tests it
E2E_DIST_DIR=dist npm run e2e:dist   # smoke-tests a NOPROD_BASE=/noprod/ build you made
```

Suites live in `e2e/suites/<name>.cjs`. `e2e:dist` runs `e2e/dist.mjs` against
the built app with browser autoplay left on its default, so it covers the
click that starts audio.

## Deploy

`.github/workflows/pages.yml` builds with `NOPROD_BASE=/noprod/`, runs the
smoke test on that build and deploys it to GitHub Pages on every push to main.
An admin enables Pages first (Settings → Pages → Source: GitHub Actions).
