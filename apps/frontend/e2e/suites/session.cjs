// Session View: clip slots launch and stop, a scene launches a row, launches
// wait for the bar, and what plays is heard at the master
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__session = await import('/src/audio/session.ts');
    // Every wait has a deadline, so a regression prints a FAIL line instead of stalling the suite
    window.__until = async (fn, ms = 6000) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
      return false;
    };
    return 1;
  });

  // Two MIDI tracks; each gets a one-bar sustained chord at 120 bpm (2 s) in scene 0 and 1,
  // track B has nothing in scene 2, track A has a clip there
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setBpm(120);
    st.addTrack('midi');
    const s2 = window.__dawStore.getState();
    const ids = s2.tracks.filter((t) => t.type === 'midi').map((t) => t.id);
    const notes = (pitch) => [0, 4, 7].map((o, i) => ({ id: `n${pitch}-${i}`, pitch: pitch + o, start: 0, duration: 1.9, velocity: 0.9 }));
    const clip = (name, pitch) => ({ type: 'midi', file: name, audioBuffer: null, duration: 2, loopEnd: 2, notes: notes(pitch) });
    s2.setSessionClip(ids[0], 0, clip('A0', 48));
    s2.setSessionClip(ids[0], 1, clip('A1', 55));
    s2.setSessionClip(ids[0], 2, clip('A2', 60));
    s2.setSessionClip(ids[1], 0, clip('B0', 60));
    s2.setSessionClip(ids[1], 1, clip('B1', 67));
    s2.setViewMode('session');
    window.__ids = ids;
    window.__cols = ids.map((id) => s2.tracks.filter((t) => t.type !== 'group').findIndex((t) => t.id === id));
    return 1;
  });
  await ctx.sleep(300);
  const ids = await page.evaluate(() => window.__ids);
  const cols = await page.evaluate(() => window.__cols);

  const snap = () => page.evaluate(() => window.__session.getSessionSnapshot());
  const listen = (ms) => page.evaluate(async (ms) => {
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      await new Promise((r) => setTimeout(r, 10));
    }
    return peak;
  }, ms);
  const slotClass = (track, slot) => page.evaluate((track, slot) => {
    const col = document.querySelectorAll('.session-view .session-track-column')[window.__cols[track]];
    return col.querySelectorAll('.session-clip-slot')[slot].className;
  }, track, slot);
  const stopTransport = async () => {
    await page.evaluate(() => { const st = window.__dawStore.getState(); if (st.isPlaying) st.togglePlayback(); return 1; });
    await ctx.sleep(300);
  };
  // Poll for the moment a track starts playing a slot, returning the transport position then
  const waitPlaying = (trackId, slot, ms = 5000) => page.evaluate(async (trackId, slot, ms) => {
    let queuedSeen = false;
    const ok = await window.__until(() => {
      const s = window.__session.getSessionSnapshot();
      if (s.queued[trackId] === slot) queuedSeen = true;
      return s.playing[trackId] === slot;
    }, ms);
    return ok ? { position: window.__transport.getPosition(), queuedSeen } : null;
  }, trackId, slot, ms);

  // 1. The grid shows the clips, and its launch button starts a clip and the transport
  const grid = await page.evaluate(() => ({
    columns: document.querySelectorAll('.session-view .session-track-column').length,
    clips: document.querySelectorAll('.session-clip-slot.has-clip').length,
    scenes: document.querySelectorAll('.scene-row').length
  }));
  check('Session View shows a grid of scenes and clips', grid.clips === 5 && grid.scenes === 8 && grid.columns >= 3, JSON.stringify(grid));
  const idle = await listen(300);
  await page.evaluate(() => { document.querySelectorAll('.session-view .session-track-column')[window.__cols[0]].querySelector('.session-launch').click(); return 1; });
  const started = await waitPlaying(ids[0], 0);
  const playingState = await page.evaluate(() => window.__dawStore.getState().isPlaying);
  await ctx.sleep(200);
  const cls = await slotClass(0, 0);
  const peak1 = await listen(800);
  check('Launching a clip from stopped starts the transport and the clip, shown on its slot', !!started && playingState && cls.includes('playing'), `${JSON.stringify(started)} ${cls}`);
  check('The playing clip is audible at the master', idle < 0.001 && peak1 > 0.01, `silent ${idle.toFixed(4)} → ${peak1.toFixed(3)}`);

  // 2. A launch while playing waits for the next bar (2 s at 120 bpm 4/4)
  const wait = await page.evaluate(async () => {
    const barOf = () => window.__transport.getPosition() % 2;
    // start just after a bar line so the wait is long and unambiguous
    await window.__until(() => barOf() >= 0.3 && barOf() <= 0.6);
    const launchedAt = window.__transport.getPosition();
    window.__session.launchClip(window.__ids[1], 0);
    const first = window.__session.getSessionSnapshot();
    let at = null;
    if (await window.__until(() => window.__session.getSessionSnapshot().playing[window.__ids[1]] === 0, 4000)) at = window.__transport.getPosition();
    return { launchedAt, queued: first.queued[window.__ids[1]], playingAtLaunch: first.playing[window.__ids[1]], at };
  });
  // The session picks up a launch 0.3 s ahead of its bar line, so the snapshot flips just before it
  const bar = Math.ceil(wait.launchedAt / 2) * 2;
  check('A launch is queued, then starts at the next bar', wait.queued === 0 && wait.playingAtLaunch === undefined && wait.at !== null && wait.at >= bar - 0.45 && wait.at <= bar + 0.1,
    JSON.stringify({ ...wait, bar }));
  const queuedClass = await page.evaluate(async () => {
    const pos = () => window.__transport.getPosition() % 2;
    await window.__until(() => pos() >= 0.3 && pos() <= 0.6);
    window.__session.launchClip(window.__ids[0], 1);
    await new Promise((r) => setTimeout(r, 100));
    return document.querySelectorAll('.session-view .session-track-column')[window.__cols[0]].querySelectorAll('.session-clip-slot')[1].className;
  });
  check('A queued slot is marked while it waits', queuedClass.includes('queued') && !queuedClass.includes('playing'), queuedClass);
  await waitPlaying(ids[0], 1);

  // 3. Quantize 'none' launches at once, '1/4' on the next beat. Each launch is timed from a
  // known place in the bar, where a bar or beat launch would wait far longer than 'none'.
  const launchTimed = (slot, trackIdx, from, to, mod) => page.evaluate(async (slot, trackIdx, from, to, mod) => {
    const id = window.__ids[trackIdx];
    const place = () => window.__transport.getPosition() % mod;
    await window.__until(() => place() >= from && place() <= to);
    const t0 = window.__transport.getPosition();
    window.__session.launchClip(id, slot);
    const queued = window.__session.getSessionSnapshot().queued[id] === slot;
    let at = null;
    if (await window.__until(() => window.__session.getSessionSnapshot().playing[id] === slot, 3000)) at = window.__transport.getPosition();
    return { t0, at, queued };
  }, slot, trackIdx, from, to, mod);
  await page.evaluate(() => { window.__dawStore.getState().setLaunchQuantization('none'); return 1; });
  const now = await launchTimed(1, 1, 0.3, 0.6, 2);
  check('With quantization off a launch starts at once, mid-bar', now.at !== null && !now.queued && now.at - now.t0 < 0.15, JSON.stringify(now));
  await page.evaluate(() => { window.__dawStore.getState().setLaunchQuantization('1/4'); return 1; });
  const beat = await launchTimed(0, 1, 0.01, 0.04, 0.5);
  const nextBeat = Math.ceil(beat.t0 / 0.5) * 0.5;
  // the session picks a launch up 0.3 s before its time, so the flip shows near nextBeat - 0.3
  check('With 1/4 quantization a launch waits for the next beat line', beat.at !== null && beat.queued && beat.at - beat.t0 > 0.05 && Math.abs(beat.at - (nextBeat - 0.3)) < 0.15,
    JSON.stringify({ ...beat, nextBeat }));
  await page.evaluate(() => { window.__dawStore.getState().setLaunchQuantization('1 bar'); return 1; });

  // 4. A scene launches its row; a track with an empty slot there stops
  await page.evaluate(() => { window.__session.launchScene(0); return 1; });
  await page.evaluate(() => window.__until(() => window.__session.getSessionSnapshot().playingScene === 0));
  const row0 = await snap();
  check('Launching scene 1 puts both tracks on slot 0', row0.playing[ids[0]] === 0 && row0.playing[ids[1]] === 0 && row0.playingScene === 0, JSON.stringify(row0.playing));
  await page.evaluate((i) => { document.querySelectorAll('.scene-row .btn-scene-launch')[i].click(); return 1; }, 2);
  const queuedScene = await snap();
  await page.evaluate(() => window.__until(() => window.__session.getSessionSnapshot().playingScene === 2));
  await ctx.sleep(300);
  const row2 = await snap();
  check('The scene button queues the scene, then a track with an empty slot there stops',
    queuedScene.queuedScene === 2 && row2.playing[ids[0]] === 2 && row2.playing[ids[1]] === undefined && row2.queuedScene === null, `${queuedScene.queuedScene} → ${JSON.stringify(row2.playing)}`);
  const peakScene = await listen(500);
  check('The scene is audible', peakScene > 0.01, peakScene.toFixed(3));

  // 5. Per-track stop and Stop All Clips, then silence
  await page.evaluate(() => { window.__session.launchScene(0); return 1; });
  await page.evaluate(() => window.__until(() => window.__session.getSessionSnapshot().playingScene === 0));
  // stop from just after a bar line, so the stop has a bar to wait for
  const stop = await page.evaluate(async (id) => {
    const place = () => window.__transport.getPosition() % 2;
    await window.__until(() => place() >= 0.3 && place() <= 0.6);
    const t0 = window.__transport.getPosition();
    document.querySelectorAll('.session-view .session-track-column')[window.__cols[1]].querySelector('.btn-stop-track').click();
    const stopped = await window.__until(() => window.__session.getSessionSnapshot().playing[id] === undefined, 4000);
    return { t0, at: stopped ? window.__transport.getPosition() : null };
  }, ids[1]);
  const afterStop = await snap();
  const stopBar = Math.ceil(stop.t0 / 2) * 2;
  check('A track\'s stop button stops its clip at the next bar and leaves the rest',
    afterStop.playing[ids[1]] === undefined && afterStop.playing[ids[0]] === 0 && stop.at !== null && stop.at - stop.t0 > 0.5 && Math.abs(stop.at - (stopBar - 0.3)) < 0.2,
    JSON.stringify({ ...stop, stopBar, playing: afterStop.playing }));
  const overridden = await page.evaluate(() => { const b = document.querySelector('.session-toolbar .back-to-arr'); return !!b && !b.disabled; });
  await page.evaluate(() => { [...document.querySelectorAll('.session-toolbar button')].find((b) => b.textContent.includes('Stop All Clips')).click(); return 1; });
  await page.evaluate(() => window.__until(() => Object.keys(window.__session.getSessionSnapshot().playing).length === 0));
  await ctx.sleep(1500); // let the last notes' sources end
  const quiet = await listen(500);
  check('Stop All Clips stops everything, and the master falls silent', quiet < 0.005, quiet.toFixed(4));
  check('Back to Arrangement lights up while the session holds tracks', overridden === true);

  // 6. Stopping the transport stops the session
  await page.evaluate((id) => { window.__session.launchClip(id, 0); return 1; }, ids[0]);
  await waitPlaying(ids[0], 0);
  await stopTransport();
  const stopped = await snap();
  check('Stopping the transport stops the session', Object.keys(stopped.playing).length === 0 && Object.keys(stopped.queued).length === 0, JSON.stringify(stopped));
  await ctx.shot('session');

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080')); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
