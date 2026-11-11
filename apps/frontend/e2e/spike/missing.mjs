// The 64-track (b) offline run played 7,320 of 7,680 notes: which tracks, and why
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const server = await createServer({ root: new URL('../..', import.meta.url).pathname, logLevel: 'error', server: { port: 5196, strictPort: false } });
await server.listen();
const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 1200000, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(server.resolvedUrls.local[0] + 'e2e/spike/bench.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.benchReady, { timeout: 60000 });
await page.evaluate(() => window.bench.prepare(44100));
for (const [tracks, seconds] of [[64, 30], [64, 10], [32, 30], [96, 10]]) {
  const r = await page.evaluate((t, s) => window.bench.offline('b', s, t), tracks, seconds);
  const short = r.perTrack.map((n, i) => [i, n]).filter(([, n]) => n !== r.perTrack[0]);
  console.log(`b ${tracks} tracks ${seconds} s: played ${r.played}/${tracks * seconds * 4}, messages ${r.messages}, late ${r.late}, pending left ${r.pendingLeft.reduce((a, b) => a + b, 0)}, tracks off: ${JSON.stringify(short)}`);
}
await browser.close();
await server.close();
