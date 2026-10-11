// #106: physical models played live, for as long as the key is held
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  // A violin on a track (the Browser's double-click puts it on a new one)
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Strings')).click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Violin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(500);
  const track = await page.evaluate(async () => {
    window.__inputs = await import('/src/audio/inputs.ts');
    const st = window.__dawStore.getState();
    return st.selectedTrackId;
  });
  const midi = (type, pitch, velocity = 0.8) => page.evaluate((type, pitch, velocity, track) => window.__inputs.publishMidi({
    type, pitch, velocity: type === 'on' ? velocity : 0, channel: 1, source: 'test-midi', time: window.__transport.audioContext.currentTime, targets: [track]
  }), type, pitch, velocity, track);
  // the master's level (dBFS RMS) over `ms`
  const level = (ms = 300) => page.evaluate(async (ms) => {
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let sum = 0, n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) { sum += x * x; n++; }
      await new Promise((r) => setTimeout(r, 20));
    }
    return 10 * Math.log10(sum / n + 1e-20);
  }, ms);
  const stats = () => page.evaluate(() => window.__transport.liveModelStats());

  // 1. Held for 6 s, it still sounds at 5.5 s (a rendered violin note is 3 s long)
  await midi('on', 67);
  await ctx.sleep(1000);
  const early = await level();
  const playing = await stats();
  await ctx.sleep(4200);
  const late = await level();
  check('A violin note held for 6 s plays live, and still sounds at 5.5 s', playing.voices === 1 && early > -40 && late > -40 && late > early - 6,
    `${early.toFixed(1)} dB at 1 s, ${late.toFixed(1)} dB at 5.5 s; ${JSON.stringify(playing)}`);

  // 2. Let go, it rings down and ends
  await midi('off', 67);
  await ctx.sleep(150);
  const ringing = await level(100);
  await ctx.sleep(1200);
  const after = await level(200);
  const ended = await stats();
  check('Let go, it rings down and ends', after < -70 && after < late - 40 && ended.voices === 0,
    `${ringing.toFixed(1)} dB just after, ${after.toFixed(1)} dB at 1.3 s; voices ${ended.voices}`);

  // 3. Eight at once, without dropouts
  const pitches = [55, 59, 62, 67, 71, 74, 79, 83];
  const before = await stats();
  for (const p of pitches) await midi('on', p, 0.6);
  await ctx.sleep(3000);
  const eight = await stats();
  const chord = await level();
  for (const p of pitches) await midi('off', p);
  const blocks = eight.blocks - before.blocks, dropped = eight.dropouts - before.dropouts, slow = eight.late - before.late;
  check('Eight violin voices play without a dropout', eight.voices === 8 && blocks > 900 && dropped === 0 && eight.load < 0.5 && chord > -40,
    `${eight.voices} voices, ${blocks} blocks: ${dropped} dropouts, ${slow} single blocks late, worst ${eight.worst} ms, load ${(eight.load * 100).toFixed(0)}%; ${chord.toFixed(1)} dB`);
  await ctx.sleep(1500);
  const quiet = await stats();
  check('…and all of them end when let go (no stuck notes)', quiet.voices === 0, `voices ${quiet.voices}`);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
