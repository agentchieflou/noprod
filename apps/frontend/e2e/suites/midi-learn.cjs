// #162: MIDI learn. A controller's CC drives any mapped control, one undo step per gesture
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);
  // Everything the checks import, up front: a late first import can make Vite reload the page
  await page.evaluate(async () => {
    window.__inputs = await import('/src/audio/inputs.ts');
    window.__devices = await import('/src/audio/devices.ts');
    window.__projectFile = await import('/src/project/projectFile.ts');
  });

  const track = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.type === 'midi');
    st.setSelectedTrackId(t.id);
    return t.id;
  });
  const state = (fn, ...args) => page.evaluate(`(${fn})(window.__dawStore.getState(), ...${JSON.stringify(args)})`);
  const volume = () => state((st, id) => st.tracks.find((t) => t.id === id).volume, track);
  const mappings = () => state((st) => st.midiMappings);
  const cc = (controller, raw) => page.evaluate((controller, raw) => window.__inputs.publishMidi({
    type: 'cc', pitch: -1, velocity: 0, controller, value: raw / 127, channel: 1, source: 'test-midi', time: 0
  }), controller, raw);
  const note = (type, pitch, target = track) => page.evaluate((type, pitch, target) => window.__inputs.publishMidi({
    type, pitch, velocity: type === 'on' ? 0.8 : 0, channel: 1, source: 'test-midi', time: window.__transport.audioContext.currentTime, targets: [target]
  }), type, pitch, target);
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
  // Waits (with a deadline) for the master to fall quiet: earlier notes ring on
  // through the reverb return, and a check of what a press adds must start after
  const settle = async (db = -70, deadline = 20000) => {
    const end = Date.now() + deadline;
    let last = await level(100);
    while (last >= db && Date.now() < end) last = await level(100);
    return last;
  };
  const learnBtn = '.midi-learn-btn';
  const clickTarget = async (key) => { await page.evaluate((key) => document.querySelector(`[data-midi-target="${key}"]`).click(), key); await ctx.sleep(80); };

  // 1. Learn mode outlines mappable controls; clicking one, then a CC, binds it
  await state((st, id) => st.updateTrackVolume(id, 0.8), track);
  check('No outlines before learn mode', (await page.$$('.midi-mappable')).length === 0);
  await page.click(learnBtn);
  await ctx.sleep(100);
  const outlined = (await page.$$('.midi-mappable')).length;
  check('Learn mode outlines the mappable controls', outlined > 5, `${outlined} outlined`);
  await ctx.shot('midi_learn_mode');
  await note('on', 60); await note('off', 60);
  await cc(7, 64);
  check('A CC with no control chosen binds nothing', (await mappings()).length === 0);
  await clickTarget(`track:${track}:volume`);
  check('Clicking a control picks it without moving it', (await state((st) => st.midiLearn.pending?.kind)) === 'track' && (await volume()) === 0.8);
  await cc(7, 64);
  const made = await mappings();
  check('Then CC 7 creates a mapping', made.length === 1 && made[0].source.type === 'cc' && made[0].source.number === 7 && made[0].target.param === 'volume', JSON.stringify(made[0]?.source));
  await page.keyboard.press('Escape');
  await ctx.sleep(100);
  check('Esc leaves learn mode', !(await state((st) => st.midiLearn.active)) && (await page.$$('.midi-mappable')).length === 0);

  // 2. The mapped CC drives the fader and, through it, the master level
  await note('on', 60);
  await ctx.sleep(300);
  await cc(7, 127);
  const loud = await level();
  check('CC 127 moves the volume to the mapping\'s max', (await volume()) === 1, `${await volume()}`);
  await cc(7, 0);
  check('CC 0 moves it to the min', (await volume()) === 0);
  await cc(7, 10);
  await ctx.sleep(100);
  const quiet = await level();
  await note('off', 60);
  check('The master level follows the controller', loud > quiet + 10 && loud > -60, `${loud.toFixed(1)} dB at max, ${quiet.toFixed(1)} dB near min`);

  // 3. Pickup does not jump
  await state((st, id) => st.updateMidiMapping(id, { mode: 'pickup' }), made[0].id);
  await state((st, id) => st.updateTrackVolume(id, 0.8), track);
  await cc(7, 0); await cc(7, 64);
  check('Pickup: a CC far from the value does nothing', (await volume()) === 0.8, `${await volume()}`);
  await cc(7, 120);
  const picked = await volume();
  check('Pickup: it takes over once the CC crosses the value', Math.abs(picked - 120 / 127) < 1e-6, `${picked}`);

  // 4. A sweep of 50 CCs is one undo step
  await state((st, id) => st.updateMidiMapping(id, { mode: 'jump' }), made[0].id);
  await state((st, id) => st.updateTrackVolume(id, 0.8), track);
  await ctx.sleep(900); // the volume write above is its own step
  const before = await state((st) => st.past.length);
  await page.evaluate(() => { for (let i = 0; i < 50; i++) window.__inputs.publishMidi({ type: 'cc', pitch: -1, velocity: 0, controller: 7, value: (i + 1) / 50, channel: 1, source: 'test-midi', time: 0 }); });
  await ctx.sleep(400);
  const after = await state((st) => st.past.length);
  check('A sweep of 50 CCs is one undo step', after === before + 1 && (await volume()) === 1, `${after - before} steps`);
  await state((st) => st.undo());
  check('Undoing it restores the value from before the sweep', (await volume()) === 0.8, `${await volume()}`);

  // 5. A device parameter, mapped through the UI, survives save and load
  const dev = await page.evaluate(async () => {
    const { createDevice } = window.__devices;
    const st = window.__dawStore.getState();
    st.addDeviceToTrack(st.selectedTrackId, createDevice('reverb'));
    const t = window.__dawStore.getState().tracks.find((x) => x.id === st.selectedTrackId);
    return t.plugins[t.plugins.length - 1].id;
  });
  await ctx.sleep(300);
  await page.click(learnBtn);
  await ctx.sleep(100);
  await clickTarget(`device:${dev}:Dry/Wet`);
  await cc(21, 30);
  await page.click(learnBtn);
  const devMap = (await mappings()).find((m) => m.target.kind === 'device');
  check('A device parameter maps from its card', !!devMap && devMap.source.number === 21, JSON.stringify(devMap?.target));
  const devValue = () => state((st, id) => st.tracks.flatMap((t) => t.plugins).find((p) => p.id === id).parameters['Dry/Wet'], dev);
  await cc(21, 127);
  check('The controller moves the device parameter', (await devValue()) === 100, `${await devValue()}`);
  const reloaded = await page.evaluate(async () => {
    const { serializeProject, deserializeProject } = window.__projectFile;
    const st = window.__dawStore.getState();
    const blob = await serializeProject(st);
    const project = await deserializeProject(blob, window.__transport.audioContext);
    st.loadProject(project, 'midi-learn');
    return window.__dawStore.getState().midiMappings.length;
  });
  check('Both mappings survive save and load', reloaded === 2, `${reloaded}`);
  await cc(21, 0);
  check('A reloaded mapping still drives the device', (await devValue()) === 0, `${await devValue()}`);

  // 6. A project that maps a missing track drops that mapping and says so
  const dropped = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    const project = Object.fromEntries(Object.keys(st).filter((k) => !(typeof st[k] === 'function')).map((k) => [k, st[k]]));
    project.midiMappings = [...st.midiMappings, { ...st.midiMappings[0], id: 'ghost', target: { kind: 'track', trackId: 'nope', param: 'volume' } }];
    st.loadProject(project, 'ghost');
    const s = window.__dawStore.getState();
    return { kept: s.midiMappings.length, dropped: s.midiLearn.dropped };
  });
  check('Loading drops a mapping to a missing track, and counts it', dropped.kept === 2 && dropped.dropped === 1, JSON.stringify(dropped));

  // 7. Removing a mapping in the list stops the control following
  await page.evaluate(() => [...document.querySelectorAll('.midi-map-btn')][0].click());
  await ctx.sleep(150);
  const rows = (await page.$$('.midi-map-row')).length;
  await ctx.shot('midi_mappings');
  check('The list shows every mapping', rows === 2, `${rows} rows`);
  await page.evaluate(() => document.querySelector('.midi-map-row .btn-icon').click());
  await ctx.sleep(100);
  const left = await mappings();
  check('Removing a mapping in the list removes it', left.length === 1);
  const v0 = await volume();
  await cc(7, 3);
  await cc(21, 100);
  check('The removed mapping\'s control stops following; the other still does',
    left[0].source.number === 21 && (await volume()) === v0 && (await devValue()) > 0, `volume ${await volume()}, device ${await devValue()}`);

  // 8. Notes meant for the keyboard are not captured when learn mode is off
  const count = (await mappings()).length;
  await state((st, id) => st.setMidiLearn({ active: false, pending: { kind: 'track', trackId: id, param: 'mute' } }), track);
  await note('on', 62); await note('off', 62);
  check('With learn mode off, notes bind nothing', (await mappings()).length === count);
  await page.click(learnBtn);
  await note('on', 62); await note('off', 62);
  await page.keyboard.press('Escape');
  check('In learn mode with nothing picked, notes bind nothing either', (await mappings()).length === count);

  // 9. A note mapped to a control drives it and plays nothing; so does the note that binds it
  await page.evaluate(() => {
    window.__midiSeen = [];
    window.__unseen = window.__inputs.onMidiEvent((e) => window.__midiSeen.push(e));
  });
  const reset = () => page.evaluate(() => { window.__midiSeen = []; });
  const seen = (pitch) => page.evaluate((pitch) => window.__midiSeen.filter((e) => e.pitch === pitch).length, pitch);
  // The mapped note is pressed with this audible track as its target, while the
  // mapping mutes `track`: if the note reached a listener, this track would play it
  const sounder = await page.evaluate(() => { window.__dawStore.getState().addTrack('midi'); return window.__dawStore.getState().tracks.at(-1).id; });
  const muted = () => state((st, id) => st.tracks.find((t) => t.id === id).isMuted, track);
  await state((st, id) => st.updateTrackVolume(id, 0.8), track);
  await page.click(learnBtn);
  await ctx.sleep(100);
  await clickTarget(`track:${track}:mute`);
  await reset();
  await note('on', 36); await note('off', 36);
  await page.keyboard.press('Escape');
  const bind = (await mappings()).find((m) => m.source.type === 'note' && m.source.number === 36);
  check('In learn mode a note binds the control picked, and plays nothing', bind?.target.param === 'mute' && (await seen(36)) === 0, `${await seen(36)} seen`);

  await reset();
  const floor = await settle();
  check('The master falls quiet before the mapped note is pressed', floor < -70, `${floor.toFixed(1)} dB`);
  await note('on', 36, sounder);
  check('A mapped note toggles its control and reaches no listener', (await muted()) && (await seen(36)) === 0, `muted ${await muted()}, ${await seen(36)} seen`);
  const held = await level(300);
  await note('off', 36, sounder);
  check('The master stays silent while the mapped note is held', held < -60 && held < Math.max(floor, -80) + 3, `${held.toFixed(1)} dB, ${floor.toFixed(1)} dB just before`);
  await note('on', 36, sounder); await note('off', 36, sounder);
  check('A second mapped note toggles the mute back', !(await muted()));

  await reset();
  await note('on', 60, sounder);
  const heard = await level(300);
  await note('off', 60, sounder);
  check('An unmapped note still plays, on the track a mapped note would have sounded on', heard > -60 && (await seen(60)) === 2, `${heard.toFixed(1)} dB, ${await seen(60)} seen`);
  await page.evaluate(() => window.__unseen());

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
