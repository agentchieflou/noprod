// What a node costs once it has finished: the same 3840 note sources either
// spread over 30 s or all played in the first second, connected for the rest
// of the render or disconnected when they end. If a finished node still
// costs, a node-per-note graph pays for every note ever scheduled.

import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const server = await createServer({ root: new URL('../..', import.meta.url).pathname, logLevel: 'error', server: { port: 5197, strictPort: false } });
await server.listen();
const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 1200000, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(server.resolvedUrls.local[0] + 'e2e/spike/bench.html', { waitUntil: 'networkidle0' });

const r = await page.evaluate(async () => {
  const sr = 44100;
  const out = {};
  const song = 30;
  const mk = (ctx) => { const b = ctx.createBuffer(2, Math.round(sr * 0.77), sr); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.05) * 0.3; } return b; };
  const render = async (count, spread, disconnect, withGain) => {
    const ctx = new OfflineAudioContext(2, sr * song, sr);
    const b = mk(ctx);
    const sink = ctx.createGain(); sink.connect(ctx.destination);
    for (let i = 0; i < count; i++) {
      const s = ctx.createBufferSource(); s.buffer = b;
      let tail = s;
      if (withGain) { const g = ctx.createGain(); s.connect(g); tail = g; }
      tail.connect(sink);
      s.start(spread ? (i % 120) * 0.25 : (i % 4) * 0.25);
      if (disconnect) s.onended = () => { s.disconnect(); if (tail !== s) tail.disconnect(); };
    }
    const t = performance.now();
    await ctx.startRendering();
    return (performance.now() - t) / 1000;
  };
  out.none = await render(0, true, false, false);
  out.spread = await render(3840, true, false, false);
  out.spreadDisconnect = await render(3840, true, true, false);
  out.firstSecond = await render(3840, false, false, false);
  out.firstSecondDisconnect = await render(3840, false, true, false);
  out.spreadWithGain = await render(3840, true, false, true);
  out.spreadWithGainDisconnect = await render(3840, true, true, true);
  out.oneQuarterWithGain = await render(960, true, false, true);
  return out;
});
for (const [k, v] of Object.entries(r)) console.log(`${k}: ${v.toFixed(2)} s for ${30} s`);
await browser.close();
await server.close();
