// Smoke test of the built app: builds it with a base path, serves dist under
// that path, and opens it the way a visitor would (autoplay policy left on its
// default, so audio starts with a click). Exits non-zero if a check fails.
//
//   npm run e2e:dist
//   E2E_DIST_DIR=dist npm run e2e:dist   # test a build you made with NOPROD_BASE=/noprod/
//
//   E2E_THROTTLE=4 npm run e2e:dist       Chromium's CPU slowed 4x, like a busy CI runner
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
  const throttle = Number(process.env.E2E_THROTTLE ?? 1);
  if (throttle > 1 && which === 'chromium') await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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
  // with its toggle, and play a note on it. Each step waits for what it needs
  // (with a deadline) rather than sleeping: a slow runner gets the same test
  const until = async (what, fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page.evaluate(fn)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const isKeys = (e) => e.textContent.trim().startsWith('Keys');
  await until('the Keys folder', `[...document.querySelectorAll('.browser-folder')].some(${isKeys})`);
  await page.evaluate((fn) => [...document.querySelectorAll('.browser-folder')].find(eval(fn))?.click(), String(isKeys));
  await until('an instrument in the Browser', `!!document.querySelector('.browser-item')`);
  await page.evaluate(() => document.querySelector('.browser-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const grand = `[...document.querySelectorAll('.track-name')].find((e) => e.textContent === 'Grand Piano')`;
  await until('the Grand Piano track', `!!${grand}`);
  await until('the Grand Piano track to be selected', `(${grand}.click(), ${grand}.closest('.track-header-box')?.classList.contains('selected'))`);
  const toggle = 'button[title^="Computer MIDI keyboard"]';
  await until('the computer keyboard to be on', `(document.querySelector('${toggle}').title.includes(' on:') || (document.querySelector('${toggle}').click(), false))`);
  const peak = page.evaluate(async () => {
    const an = window.__analysers[0];
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      window.__peak = peak;
      await new Promise((r) => setTimeout(r, 10));
    }
    return peak;
  });
  // The first press can land before the instrument's first render is ready:
  // press again until something is heard, inside the same 2.5 s window
  await sleep(200);
  let presses = 0;
  for (let i = 0; i < 4; i++) {
    presses++;
    await page.keyboard.down('KeyZ');
    await sleep(600);
    await page.keyboard.up('KeyZ');
    if ((await page.evaluate(() => window.__peak ?? 0)) > 0.01) break;
    await sleep(100);
  }
  const level = await peak;
  check('A library note is audible at the master', level > 0.01, `peak ${level.toFixed(3)} after ${presses} press${presses === 1 ? '' : 'es'}`);
  await page.screenshot({ path: join(shotDir, 'dist-noprod.png') });

  const unexpected = failedRequests.filter((r) => !/localhost:808\d/.test(r));
  check('Every asset loads under the base path', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  const realErrors = errors.filter((e) => !/ws:\/\/localhost:808\d/.test(e) && !/ERR_CONNECTION_REFUSED|WebSocket/.test(e));
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
