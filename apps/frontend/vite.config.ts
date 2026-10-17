import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// CI has the commit in the environment; a clone has git; a tarball has neither
function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  // The build works under any path: NOPROD_BASE=/noprod/ for GitHub Pages
  base: process.env.NOPROD_BASE || '/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit()),
  },
  build: {
    // Worklets load as files, so a CSP never needs to allow data: scripts
    assetsInlineLimit: 0,
    // Separate files without a reference in the bundle: they aren't served
    // unless a host adds them (CI keeps them as an artifact)
    sourcemap: 'hidden',
  },
})
