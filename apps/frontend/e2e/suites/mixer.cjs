// #161: the Mixer tab: a strip per track, return and the master; meters,
// loudness on the master, and controls that go through the store's actions
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };

  await page.mouse.click(5, 5); // resume the context

  // Helpers in the page: play a library note into a strip, set a range input as a user would
  await page.evaluate(async () => {
    const sound = await import(window.__fs + '/packages/sound/src/index.ts');
    const { audioContext } = window.__transport;
    const r = sound.render(sound.findSound('organ-drawbar'), { sampleRate: audioContext.sampleRate });
    const organ = audioContext.createBuffer(2, r.left.length, audioContext.sampleRate);
    organ.copyToChannel(r.left, 0);
    organ.copyToChannel(r.right, 1);
    const tone = audioContext.createBuffer(2, audioContext.sampleRate, audioContext.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = tone.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * 441 * i / audioContext.sampleRate);
    }
    window.__play = (trackId, which = 'organ', seconds = 3) => {
      const src = audioContext.createBufferSource();
      src.buffer = which === 'organ' ? organ : tone;
      src.connect(window.__transport.getStripInput(trackId));
      src.start();
      src.stop(audioContext.currentTime + seconds);
    };
    window.__setRange = (selector, value) => {
      const el = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.__db = (id) => parseFloat(document.querySelector(`[data-meter="${id}"]`).dataset.peak);
    return 1;
  });
  const ids = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    return { tracks: st.tracks.map((t) => t.id), returns: st.returns.map((r) => r.id) };
  });
  const track1 = ids.tracks[0];
  const state = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    return { volume: st.tracks[0].volume, sends: st.tracks[0].sends };
  });
  const openTab = (name) => page.evaluate((name) => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === name).click(), name);
  const dbs = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-meter]')].map((c) => [c.dataset.meter, parseFloat(c.dataset.peak)])));

  // Quiet start: no sends, unity master, so the numbers below are the track's own
  await page.evaluate((returns) => {
    const st = window.__dawStore.getState();
    returns.forEach((r) => st.updateTrackSend(st.tracks[0].id, r, 0));
    st.setMasterVolume(1);
    st.updateTrackVolume(st.tracks[0].id, 1);
    return 1;
  }, ids.returns);

  // 1. A strip per track, per return, and the master
  await openTab('Mixer');
  await ctx.sleep(500);
  const strips = await page.evaluate(() => [...document.querySelectorAll('.mx-strip')].map((s) => s.dataset.strip));
  const expected = [...ids.tracks, ...ids.returns, 'master'];
  check('The Mixer shows a strip per track, per return and the master, in order', strips.join() === expected.join(), strips.join());

  // 2. A note on track 1 moves its meter and the master's, and no other
  await page.evaluate((id) => window.__play(id, 'organ', 3), track1);
  await ctx.sleep(1000);
  const playing = await dbs();
  const others = Object.entries(playing).filter(([id]) => id !== track1 && id !== 'master');
  check('Track 1 plays: its meter and the master\'s move', playing[track1] > -40 && playing.master > -40, `track ${playing[track1]} dB, master ${playing.master} dB`);
  check('The other strips stay at the floor', others.every(([, v]) => v <= -100), others.map(([id, v]) => `${id} ${v}`).join(', '));
  await ctx.shot('mixer');
  await ctx.sleep(6000); // the meters fall 24 dB/s: let them reach the floor

  // 3. A fader at -inf silences its track; Ctrl+Z restores it; it is saved in the project
  await page.evaluate((id) => window.__setRange(`[data-strip="${id}"] .mx-fader`, 0), track1);
  await ctx.sleep(100);
  const silenced = await state();
  check('Moving the fader to the bottom sets the track volume to 0', silenced.volume === 0, `${silenced.volume}`);
  await page.evaluate(async () => { window.__projectFile = await import('/src/project/projectFile.ts'); return 1; });
  const saved = await page.evaluate(async () => {
    const { serializeProject, deserializeProject } = window.__projectFile;
    const blob = await serializeProject(window.__dawStore.getState());
    const project = await deserializeProject(blob, window.__transport.audioContext);
    return project.tracks[0].volume;
  });
  check('The fader\'s value survives saving and loading the project', saved === 0, `${saved}`);
  await page.evaluate((id) => window.__play(id, 'organ', 2), track1);
  await ctx.sleep(600);
  const muted = await dbs();
  check('At -inf the track is silent on the master', muted.master <= -80 && muted[track1] <= -80, `master ${muted.master} dB, track ${muted[track1]} dB`);
  await ctx.sleep(1500);
  await page.evaluate(() => { document.activeElement?.blur?.(); return 1; });
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await ctx.sleep(200);
  const restored = await state();
  check('Ctrl+Z restores the fader', restored.volume === 1, `${restored.volume}`);
  await page.evaluate((id) => window.__play(id, 'organ', 2), track1);
  await ctx.sleep(800);
  const back = await dbs();
  check('After undo the track is on the master again', back.master > -40, `master ${back.master} dB`);
  await ctx.sleep(1500);

  // 4. Double-clicking a fader resets it to 0 dB
  await page.evaluate((id) => window.__dawStore.getState().updateTrackVolume(id, 0.3), track1);
  await ctx.sleep(100);
  await page.evaluate((id) => document.querySelector(`[data-strip="${id}"] .mx-fader`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), track1);
  await ctx.sleep(100);
  check('Double-click resets the fader to 0 dB (gain 1)', (await state()).volume === 1, `${(await state()).volume}`);

  // 5. A send knob changes the return's level
  const ret = ids.returns[0];
  await page.evaluate((id) => window.__play(id, 'organ', 2), track1);
  await ctx.sleep(600);
  const noSend = (await dbs())[ret];
  await page.evaluate(([id, r]) => window.__setRange(`[data-strip="${id}"] [data-send="${r}"]`, 1), [track1, ret]);
  await ctx.sleep(600);
  const withSend = (await dbs())[ret];
  const sendValue = (await state()).sends[ret];
  check('A send knob raises the return\'s level', noSend <= -100 && withSend > -60 && sendValue === 1, `${noSend} dB -> ${withSend} dB, send ${sendValue}`);
  await ctx.sleep(1500);
  await page.evaluate(([id, r]) => window.__dawStore.getState().updateTrackSend(id, r, 0), [track1, ret]);

  // 6a. The master's loudness is measured in a worker and reported about 10 times a second
  await page.evaluate(async () => { window.__engine = await import('/src/audio/engine.ts'); return 1; });
  const reports = await page.evaluate(async () => {
    let n = 0, last = window.__engine.getLoudness();
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      const now = window.__engine.getLoudness();
      if (now !== last) { n++; last = now; }
      await new Promise((r) => setTimeout(r, 10));
    }
    return n / 2;
  });
  check('Loudness readings arrive from the worker at about 10 Hz', reports >= 6 && reports <= 14, `${reports}/s`);

  // 6. Integrated loudness of a -12 LUFS library sound played for 3 s
  await page.evaluate(() => [...document.querySelectorAll('.mx-reset')][0].click());
  await ctx.sleep(300);
  await page.evaluate((id) => window.__play(id, 'organ', 3), track1);
  await ctx.sleep(3800);
  const lufs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-lufs]')].map((e) => [e.dataset.lufs, e.textContent])));
  const integrated = parseFloat(lufs.integrated);
  check('Integrated loudness of the -12 LUFS organ reads -12 +- 1', Math.abs(integrated + 12) <= 1, JSON.stringify(lufs));
  check('True peak is shown and below the sound\'s peak ceiling', parseFloat(lufs.truePeak) < -1 && parseFloat(lufs.truePeak) > -20, `${lufs.truePeak} dBTP`);
  await page.evaluate(() => [...document.querySelectorAll('.mx-reset')][0].click());
  await ctx.sleep(300);
  const afterReset = await page.evaluate(() => document.querySelector('[data-lufs=integrated]').textContent);
  check('Reset clears the integrated value', afterReset === '-∞', afterReset);

  // 7. A full-scale tone lights the clip light; clicking clears it
  await page.evaluate((id) => window.__play(id, 'tone', 0.6), track1);
  await ctx.sleep(500);
  const lit = await page.evaluate((id) => document.querySelector(`[data-strip="${id}"] .mx-clip`).classList.contains('lit'), track1);
  await ctx.sleep(800);
  const stillLit = await page.evaluate((id) => document.querySelector(`[data-strip="${id}"] .mx-clip`).classList.contains('lit'), track1);
  await page.evaluate((id) => document.querySelector(`[data-strip="${id}"] .mx-clip`).click(), track1);
  await ctx.sleep(200);
  const cleared = await page.evaluate((id) => !document.querySelector(`[data-strip="${id}"] .mx-clip`).classList.contains('lit'), track1);
  check('A full-scale tone lights the clip light, which latches until clicked', lit && stillLit && cleared, `lit ${lit}, latched ${stillLit}, cleared ${cleared}`);

  // 8. Meters cause no store updates: updates per second while playing, Mixer open vs closed
  const updatesPerSecond = async () => page.evaluate(async () => {
    let n = 0;
    const unsub = window.__dawStore.subscribe(() => { n++; });
    window.__dawStore.getState().togglePlayback();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2500));
    window.__dawStore.getState().togglePlayback();
    const rate = n / ((performance.now() - t0) / 1000);
    unsub();
    return rate;
  });
  await page.evaluate((id) => window.__play(id, 'organ', 3), track1);
  const open = await updatesPerSecond();
  await openTab('Device Chain');
  await ctx.sleep(300);
  await page.evaluate((id) => window.__play(id, 'organ', 3), track1);
  const closed = await updatesPerSecond();
  check('Meters add no store updates (updates/s while playing: Mixer open vs closed)', Math.abs(open - closed) <= Math.max(2, closed * 0.1), `open ${open.toFixed(1)}/s, closed ${closed.toFixed(1)}/s`);

  // 9. The drawing loop runs only while the Mixer is open
  const rafPerSecond = () => page.evaluate(async () => {
    let n = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) => { n++; return raf.call(window, fn); };
    await new Promise((r) => setTimeout(r, 1000));
    window.requestAnimationFrame = raf;
    return n;
  });
  const rafClosed = await rafPerSecond();
  await openTab('Mixer');
  await ctx.sleep(300);
  const rafOpen = await rafPerSecond();
  await openTab('Device Chain');
  await ctx.sleep(300);
  const rafAgain = await rafPerSecond();
  check('The meter loop stops when the Mixer closes', rafOpen > rafClosed + 20 && rafAgain < rafOpen - 20, `closed ${rafClosed}, open ${rafOpen}, closed again ${rafAgain} frames/s`);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
