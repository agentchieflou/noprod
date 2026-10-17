// Runs the engine spike (bench.ts) in headless Chromium and prints the
// numbers for the #159 design. Writes results.json beside it.
//
//   node e2e/spike/bench.mjs            # everything (about 6 minutes)
//   node e2e/spike/bench.mjs offline    # one section: offline | realtime | latency | nodes

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..', '..');
const sections = process.argv.slice(2);
const want = (s) => !sections.length || sections.includes(s);

const server = await createServer({ root: frontend, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0] + 'e2e/spike/bench.html';

const executablePath = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 1200000, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log(`[page ${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.benchReady, { timeout: 60000 });

// CPU time (seconds) of Chromium's audio threads, from /proc: the renderer's
// realtime render thread and worklet threads carry "Audio" in their names.
// Linux only; elsewhere the load columns stay null.
function audioThreadCpu() {
  const out = {};
  try {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let cmd = '';
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!cmd.includes('--type=renderer')) continue;
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        try {
          const name = readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim();
          if (!/audio/i.test(name)) continue;
          const f = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8').split(' ');
          out[`${name}#${tid}`] = (Number(f[13]) + Number(f[14])) / 100;
        } catch { /* thread gone */ }
      }
    }
  } catch { /* no procfs */ }
  return out;
}
const cpuDelta = (before, after) => {
  const by = {};
  for (const [k, v] of Object.entries(after)) {
    const name = k.split('#')[0];
    by[name] = (by[name] || 0) + v - (before[k] ?? 0);
  }
  return by;
};

const previous = existsSync(join(here, 'results.json')) ? JSON.parse(readFileSync(join(here, 'results.json'), 'utf8')) : {};
const results = { ...previous, machine: { cores: (await import('node:os')).cpus().length, cpu: (await import('node:os')).cpus()[0]?.model }, offline: want('offline') ? [] : previous.offline || [], realtime: want('realtime') ? [] : previous.realtime || [], latency: want('latency') ? [] : previous.latency || [], nodes: want('nodes') ? null : previous.nodes || null };
const run = (fn, ...args) => page.evaluate((fn, args) => window.bench[fn](...args), fn, args);
const row = (o) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : JSON.stringify(v)}`).join(' ');

results.prepare = await run('prepare', 44100);
console.log('prepared', row(results.prepare));

if (want('offline')) {
  console.log('\n── offline: 30 s of the song, load = wall / song time');
  for (const [variant, tracks] of [['a-nodev', 32], ['b-nodev', 32], ['c', 32], ['a', 32], ['a-fdn', 32], ['c-fdn', 32], ['b', 32], ['a', 64], ['a-fdn', 64], ['b', 64]]) {
    const r = await run('offline', variant, 30, tracks);
    results.offline.push(r);
    console.log(row(r));
  }
}

if (want('realtime')) {
  console.log('\n── realtime: 14 s, main thread stalled 400 ms at 5 s and 900 ms at 9 s');
  // Projects the render thread keeps up with here: no devices at 32 tracks,
  // native devices at 4 tracks, the TypeScript engine at 32
  const runs = [['a-nodev', 32, 0.25], ['a-nodev', 32, 1.0], ['c-nodev', 32, 0.25], ['c-nodev', 32, 1.0], ['b-nodev', 32, 1.0],
    ['a', 4, 0.25], ['a-fdn', 4, 0.25], ['c', 4, 1.0], ['b', 32, 1.0], ['a', 32, 0.25], ['c', 32, 1.0]];
  for (const [variant, tracks, window] of runs) {
    const before = audioThreadCpu();
    const wall0 = performance.now();
    const r = await run('realtime', variant, 14, tracks, window, [{ at: 5, ms: 400 }, { at: 9, ms: 900 }]);
    const wall = (performance.now() - wall0) / 1000;
    const cpu = cpuDelta(before, audioThreadCpu());
    r.audioThreadLoad = Object.fromEntries(Object.entries(cpu).filter(([, s]) => s > 0.05).map(([k, s]) => [k, s / (r.seconds + 0.5)]));
    r.audioCpuSeconds = Object.values(cpu).reduce((a, b) => a + b, 0);
    r.wallSeconds = wall;
    results.realtime.push(r);
    console.log(row(r));
  }
}

if (want('latency')) {
  console.log('\n── live input: trigger on the main thread to first sample');
  for (const [variant, loaded] of [['a', false], ['c', false], ['b', false], ['a-nodev', true], ['c-nodev', true], ['b', true]]) {
    {
      const r = await run('latency', variant, 32, loaded);
      results.latency.push(r);
      console.log(row(r));
    }
  }
}

if (want('nodes')) {
  console.log('\n── whole-segment cost: creating note nodes up front');
  results.nodes = await run('nodeCost', 10000);
  console.log(row(results.nodes));
}

writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
await server.close();
