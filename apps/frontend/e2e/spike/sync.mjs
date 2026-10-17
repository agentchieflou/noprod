// Do events posted just before startRendering() reach the worklet in time?
// Without the handshake, a fast offline render can pass them first.
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const server = await createServer({ root: new URL('../..', import.meta.url).pathname, logLevel: 'error', server: { port: 5195, strictPort: false } });
await server.listen();
const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 1200000, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(server.resolvedUrls.local[0] + 'e2e/spike/bench.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.benchReady, { timeout: 60000 });
await page.evaluate(() => window.bench.prepare(44100));
for (const sync of [false, true]) {
  for (const [variant, tracks, seconds] of [['b-nodev', 32, 30], ['b-nodev', 32, 30], ['b-nodev', 32, 30], ['b-nodev', 64, 30], ['b-nodev', 96, 30], ['c-nodev', 32, 30], ['b', 32, 30]]) {
    const r = await page.evaluate((v, s, t, sy) => window.bench.offline(v, s, t, 44100, sy), variant, seconds, tracks, sync);
    const expected = tracks * seconds * 4;
    console.log(`${sync ? 'handshake' : 'no handshake'} ${variant} ${tracks} tracks: played ${r.played}/${expected}${r.late ? `, late ${r.late}` : ''}, ${r.wallSeconds.toFixed(2)} s`);
  }
}
await browser.close();
await server.close();
