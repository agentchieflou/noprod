// Smoke test of the built app: builds it with a base path, serves dist under
// that path, and opens it the way a visitor would (autoplay policy left on its
// default, so audio starts with a click). Exits non-zero if a check fails.
//
//   npm run e2e:dist
//   E2E_DIST_DIR=dist npm run e2e:dist   # test a build you made with NOPROD_BASE=/noprod/
//
//   E2E_BROWSER=firefox npm run e2e:dist   # Firefox, over WebDriver BiDi
//   E2E_BROWSER=webkit npm run e2e:dist    # WebKit, through Playwright
//
// Chromium: CHROME_PATH, else /opt/pw-browsers/chromium if present, else
// Puppeteer's own download. Firefox: `npx puppeteer browsers install firefox`.
// WebKit: `npx playwright install webkit` (Playwright is Apache-2.0, dev only).

import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const BASE = '/noprod/';
const ownBuild = !process.env.E2E_DIST_DIR;
const outDir = ownBuild ? mkdtempSync(join(tmpdir(), 'noprod-dist-')) : resolve(process.env.E2E_DIST_DIR);
const shotDir = join(here, '.shots');
mkdirSync(shotDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`;
  results.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (ownBuild) {
  process.env.NOPROD_BASE = BASE;
  await build({ root: frontend, logLevel: 'error', build: { outDir, emptyOutDir: true } });
}

// Production builds have no test handles, so this host adds a script that taps
// the master analyser as the engine creates it. (Puppeteer's
// evaluateOnNewDocument raises a page error in Firefox.)
const TAP = `window.__analysers = [];
const create = AudioContext.prototype.createAnalyser;
AudioContext.prototype.createAnalyser = function () { const an = create.call(this); window.__analysers.push(an); return an; };`;

// A static host that serves dist only under BASE
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) || 'index.html' : null;
  const file = rel && resolve(outDir, rel);
  if (!file || !file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(file === resolve(outDir, 'index.html') ? Buffer.from(body.toString().replace('<head>', `<head><script>${TAP}</script>`)) : body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;
console.log(`dist at ${url}`);

// Playwright's page has Puppeteer's methods this suite uses, bar these two
async function launchWebkit() {
  const { webkit } = await import('playwright-core');
  const b = await webkit.launch();
  const newPage = b.newPage.bind(b);
  b.newPage = async () => {
    const page = await newPage();
    page.setViewport = (v) => page.setViewportSize(v);
    const goto = page.goto.bind(page);
    page.goto = (u, o = {}) => goto(u, { ...o, waitUntil: o.waitUntil === 'networkidle0' ? 'networkidle' : o.waitUntil });
    return page;
  };
  return b;
}

const which = process.env.E2E_BROWSER || 'chromium';
const executablePath = which === 'chromium' ? (process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)) : undefined;
const browser = which === 'webkit' ? await launchWebkit() : await puppeteer.launch(
  which === 'firefox'
    ? { browser: 'firefox', headless: true }
    : { executablePath, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
console.log(`browser: ${which} ${await browser.version()}`);
try {
  // The build itself
  const files = (dir) => readdirSync(dir, { recursive: true }).map(String);
  const assets = files(join(outDir, 'assets'));
  const scripts = assets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(outDir, 'assets', f), 'utf8'));
  check('No scripts are inlined as data: URLs', !scripts.some((s) => /data:(text|application)\/javascript/.test(s)));
  check('Sourcemaps are separate files the bundle does not reference', assets.some((f) => f.endsWith('.js.map')) && !scripts.some((s) => /sourceMappingURL/.test(s)));
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  check('index.html is noprod\'s own', /<title>noprod<\/title>/.test(html) && /name="description"/.test(html) && /<noscript>/.test(html) && html.includes(`${BASE}favicon.svg`) && html.includes(`${BASE}manifest.webmanifest`));

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  const messages = []; // everything the page logs, shown if the note stays silent
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { messages.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.daw-container', { timeout: 30000 });

  check('The app renders under the base path', true, url);
  check('The page is titled noprod', (await page.title()) === 'noprod');
  const version = await page.$eval('.app-version', (e) => e.textContent).catch(() => '');
  check('The version and commit are shown', /^v\d+\.\d+\.\d+ · \S+$/.test(version), version);

  const state = () => page.evaluate(() => window.__analysers[0]?.context.state);
  check('Audio waits for a click (autoplay policy is the default)', (await state()) === 'suspended', String(await state()));
  // Play is the click that starts audio; stop again so only the note is heard
  await page.click('button[title="Play"]');
  await sleep(300);
  await page.click('button[title="Play"]');
  // Firefox takes a moment to start the audio device
  for (let i = 0; i < 40 && (await state()) !== 'running'; i++) await sleep(50);
  check('A click starts audio', (await state()) === 'running', String(await state()));

  // Add a library instrument from the Browser, turn on the computer keyboard
  // with its toggle, and play a note on it
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Keys'))?.click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('.browser-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.track-name')].find((e) => e.textContent === 'Grand Piano')?.click());
  await page.click('button[title^="Computer MIDI keyboard"]');
  await sleep(300);
  // The first note on a fresh instrument sounds when its render arrives, if
  // the key is still held (a cold worker on a slow runner takes seconds), and
  // a window blur in a headless browser lets held keys go. So the key stays
  // down until the master moves, up to 3 s, and is pressed again, up to 3 times.
  const heard = (ms) => page.evaluate(async (ms) => {
    const an = window.__analysers[0];
    const buf = new Float32Array(an.fftSize);
    const start = performance.now();
    let peak = 0, heardAt = null;
    while (performance.now() - start < ms && (heardAt === null || performance.now() - heardAt < 300)) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      if (peak > 0.01 && heardAt === null) heardAt = performance.now();
      await new Promise((r) => setTimeout(r, 10));
    }
    return peak;
  }, ms);
  const t0 = Date.now();
  let level = 0, presses = 0;
  while (presses < 3 && level < 0.01) {
    presses++;
    const listening = heard(3000);
    await sleep(200);
    await page.keyboard.down('KeyZ');
    level = await listening;
    await page.keyboard.up('KeyZ');
    await sleep(100);
  }
  const after = ((Date.now() - t0) / 1000).toFixed(1);
  // A silent note says where it got stuck: the context, the track, the toggle, the logs
  const why = level > 0.01 ? '' : await page.evaluate(() => {
    const ctx = window.__analysers[0]?.context;
    return ` · ${ctx?.state} at ${ctx?.sampleRate} Hz, ${document.querySelectorAll('.track-name').length} tracks, ${document.querySelector('button[title^="Computer MIDI keyboard"]')?.title.split(':')[0]}`;
  }) + ` · console: ${messages.join(' | ') || 'quiet'}`;
  check('A library note is audible at the master', level > 0.01, `peak ${level.toFixed(3)}, press ${presses}, ${after} s${why}`);
  await page.screenshot({ path: join(shotDir, 'dist-noprod.png') });

  const unexpected = failedRequests.filter((r) => !r.includes('localhost:8080'));
  check('Every asset loads under the base path', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  const realErrors = errors.filter((e) => !e.includes('ws://localhost:8080') && !/ERR_CONNECTION_REFUSED|WebSocket/.test(e));
  check('No page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (e) {
  check(`dist suite stopped: ${e.message}`, false);
} finally {
  await browser.close();
  server.close();
  if (ownBuild) rmSync(outDir, { recursive: true, force: true });
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
