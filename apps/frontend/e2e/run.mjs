// Browser tests: starts the frontend on a port of its own, runs each suite
// in a fresh headless browser, and exits non-zero if any check fails.
//
//   npm run e2e                       every suite
//   npm run e2e -- designer dspmap    just these
//   E2E_SKIP=dictation npm run e2e    all but these
//
// A suite (suites/<name>.cjs) exports `async (page, ctx) => {}` and prints a
// line per check, starting PASS or FAIL. The dictation suite also runs the
// Sequencer (Strudel, loaded from unpkg) and a stand-in orchestrator.
//
// Chromium: CHROME_PATH, else /opt/pw-browsers/chromium if present, else
// Puppeteer's own download.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { render, encodeWav, findSound } from '../../../packages/sound/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const root = resolve(here, '../../..');
const require = createRequire(import.meta.url);

const ORDER = ['library', 'designer', 'resynth', 'modeled', 'dspmap', 'coach', 'dictation'];
const asked = process.argv.slice(2);
const skip = (process.env.E2E_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const suites = (asked.length ? asked : ORDER).filter((s) => !skip.includes(s));
for (const s of suites) if (!existsSync(join(here, 'suites', `${s}.cjs`))) throw new Error(`no suite ${s}`);

const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const shotDir = join(here, '.shots');
mkdirSync(shotDir, { recursive: true });

// Recordings for the resynthesis suite, rendered from the library
const fixtures = mkdtempSync(join(tmpdir(), 'noprod-e2e-'));
const marimba = render(findSound('marimba'), { note: 64, sampleRate: 44100 });
writeFileSync(join(fixtures, 'Marimba E4.wav'), encodeWav([marimba.left, marimba.right], 44100, 16));
const hat = render(findSound('hat-open'), { sampleRate: 48000 });
writeFileSync(join(fixtures, 'Open Hat.wav'), encodeWav([hat.left, hat.right], 48000, 24));

const server = await createServer({ root: frontend, logLevel: 'error', server: { port: Number(process.env.E2E_PORT ?? 5190), strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`frontend at ${url}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The dictation suite's services: the Sequencer, then the stand-in orchestrator
async function startDictationServices() {
  const sequencer = spawn(process.execPath, [join(root, 'apps/sequencer/index.js')], { cwd: join(root, 'apps/sequencer'), stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 60000);
    sequencer.stdout.on('data', (d) => { if (/Engine Ready/i.test(d.toString())) { clearTimeout(timer); done(true); } });
    sequencer.on('exit', () => { clearTimeout(timer); done(false); });
  });
  const orchestrator = spawn(process.execPath, [join(here, 'fake-orchestrator.mjs')], { stdio: 'ignore' });
  await sleep(1500);
  return { ready, stop: () => { sequencer.kill(); orchestrator.kill(); } };
}

const results = [];
for (const name of suites) {
  console.log(`\n── ${name}`);
  const services = name === 'dictation' ? await startDictationServices() : null;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('dialog', async (d) => { logs.push(`[dialog] ${d.message()}`); await d.accept(); });
  // Suites import the repo's packages into the page through Vite's /@fs/
  await page.evaluateOnNewDocument((fs) => { window.__fs = fs; }, `/@fs${root}`);

  const lines = [];
  const log = console.log;
  console.log = (...args) => {
    for (const line of args.join(' ').split('\n')) if (/^(PASS|FAIL) /.test(line)) lines.push(line);
    log(...args);
  };
  try {
    if (services && !services.ready) throw new Error('the Sequencer did not start (it loads Strudel from unpkg)');
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    const suite = require(join(here, 'suites', `${name}.cjs`));
    const ctx = { sleep, logs, fixtures, shotDir, shot: (n) => page.screenshot({ path: join(shotDir, `${n}.png`) }) };
    await Promise.race([suite(page, ctx), sleep(10 * 60000).then(() => { throw new Error('timed out after 10 minutes'); })]);
  } catch (e) {
    lines.push(`FAIL ${name} stopped: ${e.message}`);
    log(`FAIL ${name} stopped: ${e.stack || e}`);
  } finally {
    console.log = log;
  }
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  if (failed.length && process.env.E2E_VERBOSE !== '0') {
    console.log('page log (errors and warnings):');
    for (const l of logs.filter((x) => /^\[(error|pageerror|warn)/.test(x)).slice(-30)) console.log(`  ${l}`);
  }
  results.push({ name, passed: lines.length - failed.length, failed });
  await browser.close();
  services?.stop();
}

await server.close();
console.log('\n── summary');
for (const r of results) console.log(`${r.failed.length ? 'FAIL' : 'ok  '} ${r.name}: ${r.passed}/${r.passed + r.failed.length}`);
const failures = results.flatMap((r) => r.failed);
if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
process.exit(0);
