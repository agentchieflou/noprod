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
  const violinTrack = await page.evaluate(async () => {
    window.__inputs = await import('/src/audio/inputs.ts');
    const st = window.__dawStore.getState();
    return st.selectedTrackId;
  });
  let track = violinTrack;
  const midi = (type, pitch, velocity = 0.8) => page.evaluate((type, pitch, velocity, track) => window.__inputs.publishMidi({
    type, pitch, velocity: type === 'on' ? velocity : 0, channel: 1, source: 'test-midi', time: window.__transport.audioContext.currentTime, targets: [track]
  }), type, pitch, velocity, track);
  const control = (type, value, controller) => page.evaluate((type, value, controller, track) => window.__inputs.publishMidi({
    type, pitch: -1, velocity: 0, controller, value, channel: 1, source: 'test-midi', time: window.__transport.audioContext.currentTime, targets: [track]
  }), type, value, controller, track);
  // the master's pitch (Hz), over a few analyser frames
  const pitch = (lo, hi) => page.evaluate(async (lo, hi) => {
    const { estimatePitch } = await import(window.__fs + '/packages/sound/src/analysis.ts');
    const an = window.__transport.masterAnalyser, sr = window.__transport.audioContext.sampleRate;
    const buf = new Float32Array(an.fftSize), found = [];
    for (let k = 0; k < 6; k++) {
      an.getFloatTimeDomainData(buf);
      const hz = estimatePitch(buf, sr, 0, buf.length, lo, hi);
      if (hz > 0) found.push(hz);
      await new Promise((r) => setTimeout(r, 60));
    }
    found.sort((a, b) => a - b);
    return found[found.length >> 1] ?? 0;
  }, lo, hi);
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

  // 3. Expression (CC11): the bow eased off, then drawn full: more than 6 dB between
  await midi('on', 67);
  await ctx.sleep(800);
  await control('cc', 0, 11);
  await ctx.sleep(1000);
  const eased = await level(200);
  await control('cc', 1, 11);
  await ctx.sleep(800);
  const drawn = await level(200);
  await midi('off', 67);
  check('CC11 from 0 to 127 swells the bow by more than 6 dB', drawn - eased > 6, `${eased.toFixed(1)} → ${drawn.toFixed(1)} dB`);
  await ctx.sleep(1200);

  // 4. Eight at once, without dropouts
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

  // 5. Pitch bend: a recorder (no vibrato of its own, and legato) bent up 2 semitones
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Winds')).click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Recorder').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(500);
  track = await page.evaluate(() => window.__dawStore.getState().selectedTrackId);
  await midi('on', 72);
  await ctx.sleep(800);
  const straight = await pitch(300, 1000);
  await control('bend', 1);
  await ctx.sleep(500);
  const bent = await pitch(300, 1000);
  await control('bend', 0);
  await midi('off', 72);
  const moved = 1200 * Math.log2(bent / straight);
  check('Pitch bend up full moves the pitch 200 cents (± 10)', Math.abs(moved - 200) <= 10, `${straight.toFixed(1)} Hz → ${bent.toFixed(1)} Hz: ${moved.toFixed(1)} cents`);
  await ctx.sleep(800);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
