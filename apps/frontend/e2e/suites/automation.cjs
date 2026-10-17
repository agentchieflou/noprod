// Automation lanes: add a lane and breakpoints in the timeline, hear the
// parameter follow during playback (sampled at two times), and undo
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__engine = await import('/src/audio/engine.ts');
    window.__devices = await import('/src/audio/devices.ts');
    window.__auto = await import('/src/audio/automation.ts');
    window.__tp = await import('/src/audio/transport.ts');
    // Every wait has a deadline, so a regression prints a FAIL line instead of stalling the suite
    window.__until = async (fn, ms = 6000) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
      return false;
    };
    return 1;
  });
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setBpm(120);
    window.__track = st.tracks.find((t) => t.type === 'midi').id;
    st.addDeviceToTrack(window.__track, window.__devices.createDevice('delay'));
    return 1;
  });
  await ctx.sleep(300);
  const trackId = await page.evaluate(() => window.__track);
  const track = () => page.evaluate((id) => window.__dawStore.getState().tracks.find((t) => t.id === id), trackId);
  const points = (key) => track().then((t) => t.automation?.[key] || []);

  // 1. The Activity button on the track shows a volume lane
  const trackIndex = await page.evaluate((id) => window.__dawStore.getState().tracks.findIndex((t) => t.id === id), trackId);
  await page.evaluate((i) => { document.querySelectorAll('button[title="Show automation lanes"]')[i]?.click(); return 1; }, trackIndex);
  await ctx.sleep(200);
  const lane = await page.evaluate(() => ({
    header: document.querySelectorAll('.automation-lane-header').length,
    svg: document.querySelectorAll('svg.automation-lane').length,
    label: document.querySelector('.automation-lane-header select')?.selectedOptions[0]?.textContent,
    count: document.querySelector('.automation-count')?.textContent
  }));
  const t0 = await track();
  check('The track button opens a volume lane, empty to start', lane.header === 1 && lane.svg === 1 && lane.label === 'Volume' && lane.count === 'empty' && t0.automationLanes[0] === 'volume', JSON.stringify(lane));

  // 2. Click the lane to add breakpoints: high at 0 s, low at 2 s, back up at 4 s
  // (lane is 56 px high with 5 px padding: y=5 is 1.0, y=51 is 0.0; 50 px per second)
  const box = await page.evaluate(() => { const el = document.querySelector('svg.automation-lane'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const click = async (sec, y) => {
    await page.mouse.move(box.x + sec * 50, box.y + y);
    await page.mouse.down();
    await page.mouse.up();
    await ctx.sleep(80);
  };
  const baseline = await page.evaluate(() => window.__dawStore.getState().past.length);
  await click(0, 5); await click(2, 41); await click(4, 5);
  const vol = await points('volume');
  check('Clicking the lane adds breakpoints sorted by time, snapped to the grid',
    vol.length === 3 && vol.map((p) => p.time).join() === '0,2,4' && Math.abs(vol[0].value - 1) < 0.02 && Math.abs(vol[1].value - 0.22) < 0.03 && Math.abs(vol[2].value - 1) < 0.02,
    JSON.stringify(vol.map((p) => [p.time, +p.value.toFixed(2)])));
  const uiAfter = await page.evaluate(() => ({ count: document.querySelector('.automation-count')?.textContent, circles: document.querySelectorAll('svg.automation-lane circle').length, path: !!document.querySelector('svg.automation-lane path') }));
  check('The lane draws its points and the header counts them', uiAfter.count === '3 pts' && uiAfter.circles === 3 && uiAfter.path, JSON.stringify(uiAfter));

  // 3. The parameter follows the envelope during playback: sample the fader at two times
  const sample = (key) => page.evaluate(async (key) => {
    const target = window.__engine.getAutomationTargets(window.__track, key)[0].param;
    const st = window.__dawStore.getState();
    const pts = st.tracks.find((t) => t.id === window.__track).automation[key];
    const out = [];
    for (const at of [0.2, 2, 3]) {
      await window.__until(() => window.__transport.getPosition() >= at);
      out.push({ position: window.__transport.getPosition(), value: target.value, expected: window.__tp.envelopeAt(pts, window.__transport.getPosition()) });
    }
    return out;
  }, key);
  const staticVolume = await page.evaluate((id) => window.__dawStore.getState().tracks.find((t) => t.id === id).volume, trackId);
  await page.evaluate(() => { const st = window.__dawStore.getState(); window.__transport.setPosition(0); if (!st.isPlaying) st.togglePlayback(); return 1; });
  const samples = await sample('volume');
  await page.evaluate(() => { const st = window.__dawStore.getState(); if (st.isPlaying) st.togglePlayback(); return 1; });
  check('During playback the fader follows the envelope', samples.every((s) => Math.abs(s.value - s.expected) < 0.06) && samples[0].value > samples[1].value + 0.3 && samples[2].value > samples[1].value + 0.1,
    samples.map((s) => `${s.position.toFixed(2)}s ${s.value.toFixed(2)} (want ${s.expected.toFixed(2)})`).join(' | '));
  await ctx.sleep(300);
  const restored = await page.evaluate((id) => window.__engine.getAutomationTargets(id, 'volume')[0].param.value, trackId);
  check('When playback stops the fader returns to its static value', Math.abs(restored - staticVolume) < 0.02, `${restored.toFixed(2)} vs ${staticVolume}`);

  // 4. Dragging a point moves it; double-click removes it
  await page.mouse.move(box.x + 2 * 50, box.y + 41);
  await page.mouse.down();
  await page.mouse.move(box.x + 3 * 50, box.y + 20, { steps: 4 });
  await page.mouse.up();
  await ctx.sleep(100);
  const dragged = await points('volume');
  check('Dragging a point moves it in time and value', dragged.length === 3 && dragged[1].time === 3 && dragged[1].value > 0.5 && dragged[1].value < 0.8, JSON.stringify(dragged.map((p) => [p.time, +p.value.toFixed(2)])));
  const px = box.x + 3 * 50, py = box.y + 20;
  await page.mouse.move(px, py);
  for (const clickCount of [1, 2]) { await page.mouse.down({ clickCount }); await page.mouse.up({ clickCount }); }
  await ctx.sleep(100);
  const removed = await points('volume');
  check('Double-clicking a point deletes it', removed.length === 2 && removed.map((p) => p.time).join() === '0,4', JSON.stringify(removed.map((p) => p.time)));

  // 5. Undo reverts the last edit, redo restores it
  await page.evaluate(() => { window.__dawStore.getState().undo(); return 1; });
  const undone = await points('volume');
  await page.evaluate(() => { window.__dawStore.getState().redo(); return 1; });
  const redone = await points('volume');
  check('Undo brings the deleted point back, redo removes it again', undone.length === 3 && redone.length === 2, `${undone.length} → ${redone.length}`);
  await page.evaluate((n) => { while (window.__dawStore.getState().past.length > n) window.__dawStore.getState().undo(); return 1; }, baseline);
  const empty = await points('volume');
  check('Undoing every edit empties the lane', empty.length === 0, String(empty.length));

  // 6. Pan and device lanes: choose them from the lane's menu, the parameter follows
  await page.evaluate(() => {
    const s = window.__dawStore.getState();
    const param = window.__auto.automationParams(s.tracks.find((t) => t.id === window.__track), s.returns).find((p) => p.key.endsWith(':Dry/Wet'));
    window.__deviceKey = param.key;
    s.setAutomationPoints(window.__track, 'pan', [{ time: 0, value: -1 }, { time: 4, value: 1 }]);
    s.setAutomationPoints(window.__track, param.key, [{ time: 0, value: param.min }, { time: 4, value: param.max }]);
    s.setAutomationLanes(window.__track, ['volume', 'pan', param.key]);
    return 1;
  });
  await ctx.sleep(300);
  const menu = await page.evaluate(() => [...document.querySelectorAll('.automation-lane-header select')].map((s) => s.selectedOptions[0].textContent));
  check('Lanes for volume, pan and a device parameter are listed', menu.length === 3 && menu[1].startsWith('Pan') && menu[2].startsWith('NoProd Delay'), menu.join(' / '));
  await page.evaluate(() => { const st = window.__dawStore.getState(); window.__transport.setPosition(0); if (!st.isPlaying) st.togglePlayback(); return 1; });
  const panSamples = await page.evaluate(async () => {
    const pan = window.__engine.getAutomationTargets(window.__track, 'pan')[0].param;
    const dev = window.__engine.getAutomationTargets(window.__track, window.__deviceKey);
    const read = () => ({ pan: pan.value, dev: dev.map((d) => d.param.value) });
    await window.__until(() => window.__transport.getPosition() >= 0.3);
    const a = read();
    await window.__until(() => window.__transport.getPosition() >= 3);
    return { a, b: read(), targets: dev.length };
  });
  await page.evaluate(() => { const st = window.__dawStore.getState(); if (st.isPlaying) st.togglePlayback(); return 1; });
  check('Pan sweeps from left toward right during playback', panSamples.a.pan < -0.7 && panSamples.b.pan > 0.4, `${panSamples.a.pan.toFixed(2)} → ${panSamples.b.pan.toFixed(2)}`);
  check('A device parameter follows its lane', panSamples.targets > 0 && panSamples.a.dev.some((v, i) => Math.abs(v - panSamples.b.dev[i]) > 0.1), JSON.stringify(panSamples));

  // 7. Clear erases a lane in one step
  await page.evaluate(() => { document.querySelectorAll('.automation-lane-header')[1].querySelector('button[title="Clear this envelope"]').click(); return 1; });
  const cleared = await track();
  check('The clear button erases the lane\'s envelope', !cleared.automation.pan && cleared.automation.volume === undefined, JSON.stringify(Object.keys(cleared.automation || {})));
  await ctx.shot('automation');

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080')); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
