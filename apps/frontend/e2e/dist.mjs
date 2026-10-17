// Smoke test of the built app: builds it with a base path, serves dist under
// that path, and opens it the way a visitor would (autoplay policy left on its
// default, so audio starts with a click). Exits non-zero if a check fails.
//
//   npm run e2e:dist
//   E2E_DIST_DIR=dist npm run e2e:dist   # test a build you made with NOPROD_BASE=/noprod/
//
// Chromium: CHROME_PATH, else /opt/pw-browsers/chromium if present, else
// Puppeteer's own download.

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
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;
console.log(`dist at ${url}`);

const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());
  // Production builds have no test handles, so tap the master analyser as the
  // engine creates it
  await page.evaluateOnNewDocument(() => {
    window.__analysers = [];
    const create = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () {
      const an = create.call(this);
      window.__analysers.push(an);
      return an;
    };
  });
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
  const peak = page.evaluate(async () => {
    const an = window.__analysers[0];
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      await new Promise((r) => setTimeout(r, 10));
    }
    return peak;
  });
  await sleep(200);
  await page.keyboard.down('KeyZ');
  await sleep(600);
  await page.keyboard.up('KeyZ');
  const level = await peak;
  check('A library note is audible at the master', level > 0.01, `peak ${level.toFixed(3)}`);
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
