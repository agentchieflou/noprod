// Project files: build a project (tracks, MIDI and audio clips, library
// instruments with edits, a device, automation, a session clip and scene,
// a return), save it from the File menu, start a new project, open the file,
// and check the state came back
const fs = require('node:fs');
const path = require('node:path');

module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__lib = await import('/src/audio/library.ts');
    window.__devices = await import('/src/audio/devices.ts');
    window.__store = await import('/src/store/useDAWStore.js');
    window.__sound = await import(window.__fs + '/packages/sound/src/index.ts');
    return 1;
  });

  // 1. Build the project
  const built = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const { LIBRARY, KITS } = window.__sound;
    st.setBpm(96);
    st.setTimeSignature(2, 3, 4);
    st.addReturn();

    // A library sound with an edit, and a kit with an edited drum
    const choir = LIBRARY.find((r) => r.id === 'pad-choir');
    st.addMidiTrackWithInstrument(window.__lib.createLibraryInstrument(choir), 'Choir');
    const choirTrack = window.__dawStore.getState().tracks.at(-1);
    st.updateInstrumentParameter(choirTrack.id, 'Library', { sound: { ...choir, name: 'Edited Choir', length: 3.25 } });
    const kit = KITS.find((k) => k.id === 'kit-808');
    const sounds = window.__lib.kitSounds(kit);
    sounds['kick-808'] = { ...sounds['kick-808'], name: 'Edited Kick' };
    st.addMidiTrackWithInstrument({ id: 'kit-instrument', name: '808', type: 'instrument', parameters: { Kit: 'library', Gain: 1, Tune: 0, Library: { kit, sounds } } }, '808 Kit');
    const kitTrack = window.__dawStore.getState().tracks.at(-1);

    // MIDI clip, and an audio clip with known samples
    st.addMidiRegion(choirTrack.id, 1, 4, [60, 64, 67].map((pitch, i) => ({ id: `m${i}`, pitch, start: i * 0.5, duration: 0.5, velocity: 0.7 })));
    const ctxA = window.__transport.audioContext;
    const buf = ctxA.createBuffer(2, 4410, 44100);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin((i * (c + 1) * 2 * Math.PI) / 100) * 0.5; }
    const audio = st.tracks.find((t) => t.type === 'audio');
    st.addRegion({ trackId: audio.id, file: 'sine.wav', startTime: 0.5, duration: 0.1, audioBuffer: buf, type: 'audio' });

    // A device, automation, a send
    st.addDeviceToTrack(choirTrack.id, window.__devices.createDevice('delay'));
    const device = window.__dawStore.getState().tracks.find((t) => t.id === choirTrack.id).plugins.at(-1);
    st.updateDeviceParameter(choirTrack.id, device.id, 'Feedback', 61);
    st.setAutomationPoints(choirTrack.id, 'volume', [{ time: 0, value: 0.9 }, { time: 2, value: 0.3 }]);
    st.setAutomationPoints(choirTrack.id, 'pan', [{ time: 1, value: -0.5 }]);
    st.setAutomationLanes(choirTrack.id, ['volume', 'pan']);
    const ret = window.__dawStore.getState().returns[0];
    st.updateTrackSend(choirTrack.id, ret.id, 0.35);
    st.updateTrackVolume(choirTrack.id, 0.55);

    // A session clip, and scene settings
    st.setSessionClip(choirTrack.id, 1, { type: 'midi', file: 'Hook', audioBuffer: null, duration: 2.5, loopEnd: 2.5, notes: [{ id: 's0', pitch: 72, start: 0, duration: 1, velocity: 0.8 }] });
    st.updateScene(1, { name: 'Chorus', tempo: 110, follow: { enabled: true, bars: 4, action: 'next' } });
    st.setLaunchQuantization('1/4');
    return { choir: choirTrack.id, kit: kitTrack.id, device: device.id, ret: ret.id };
  });
  await ctx.sleep(300);

  // What the project holds, with audio reduced to its samples
  const describe = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const out = {};
    window.__store.PROJECT_KEYS.forEach((k) => { out[k] = st[k]; });
    return JSON.stringify(out, (_k, v) => {
      if (typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer) {
        let sum = 0;
        for (let c = 0; c < v.numberOfChannels; c++) { const d = v.getChannelData(c); for (let i = 0; i < d.length; i++) sum += d[i] * (i + 1) * (c + 1); }
        return { audio: [v.numberOfChannels, v.length, v.sampleRate, +sum.toFixed(3)] };
      }
      return v;
    });
  });
  const before = await describe();
  const sizes = await page.evaluate(() => { const s = window.__dawStore.getState(); return { tracks: s.tracks.length, returns: s.returns.length, regions: s.regions.length, dirty: window.__store.isProjectDirty(s) }; });
  check('The project has tracks, clips and edits to save', sizes.tracks === 4 && sizes.returns === 3 && sizes.regions === 2 && sizes.dirty, JSON.stringify(sizes));

  // 2. Save As from the File menu: no file picker here, so the app downloads a copy
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
    window.showOpenFilePicker = undefined;
    window.__download = null;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        const name = this.download;
        window.__download = fetch(this.href).then((r) => r.arrayBuffer()).then((b) => ({ name, bytes: [...new Uint8Array(b)] }));
        return;
      }
      return click.call(this);
    };
    return 1;
  });
  await page.click('.file-menu-btn');
  await page.evaluate(() => { [...document.querySelectorAll('.file-menu-list button')].find((b) => b.textContent.startsWith('Save As')).click(); return 1; });
  const file = await page.evaluate(async () => { for (let i = 0; i < 100 && !window.__download; i++) await new Promise((r) => setTimeout(r, 50)); return window.__download; });
  const afterSave = await page.evaluate(() => ({ dirty: window.__store.isProjectDirty(window.__dawStore.getState()), name: document.querySelector('.project-name').textContent }));
  const bytes = file && Buffer.from(file.bytes);
  check('Save As downloads a .noprod file (v2 signature) and marks the project saved', !!bytes && file.name.endsWith('.noprod') && bytes.subarray(0, 8).join() === '137,78,80,82,74,13,10,26' && !afterSave.dirty,
    file ? `${file.name}, ${(bytes.length / 1024).toFixed(1)} KB, dirty ${afterSave.dirty}` : 'no download');

  // 3. New Project clears everything
  await page.click('.file-menu-btn');
  await page.evaluate(() => { [...document.querySelectorAll('.file-menu-list button')].find((b) => b.textContent === 'New Project').click(); return 1; });
  await ctx.sleep(300);
  const cleared = await page.evaluate(() => {
    const s = window.__dawStore.getState();
    return { regions: s.regions.length, sessionClips: Object.keys(s.sessionClips).length, returns: s.returns.length, bpm: s.bpm, name: s.projectName, tracks: s.tracks.map((t) => t.name) };
  });
  const afterNew = await describe();
  check('New Project starts from the default project', cleared.regions === 0 && cleared.sessionClips === 0 && cleared.returns === 2 && cleared.bpm !== 96 && cleared.name === 'Untitled' && afterNew !== before && !cleared.tracks.includes('Choir'), JSON.stringify(cleared));

  // 4. Open the saved file through the File menu's file input
  const saved = path.join(ctx.fixtures, 'Round Trip.noprod');
  fs.writeFileSync(saved, bytes);
  await page.evaluate(() => { window.__dawStore.getState().setSelectedTrackId(window.__dawStore.getState().tracks[0].id); return 1; });
  const input = await page.$('.file-menu input[type=file]');
  await input.uploadFile(saved);
  await page.evaluate(async () => { for (let i = 0; i < 100 && !window.__dawStore.getState().regions.length; i++) await new Promise((r) => setTimeout(r, 50)); return 1; });
  await ctx.sleep(300);
  const after = await describe();
  const loaded = await page.evaluate(() => {
    const s = window.__dawStore.getState();
    return { name: s.projectName, shown: document.querySelector('.project-name').textContent, dirty: window.__store.isProjectDirty(s), undo: s.past.length, selected: s.selectedTrackId, playing: s.isPlaying };
  });
  check('Opening the file restores every project field, audio samples included', after === before, after === before ? `${(before.length / 1024).toFixed(0)} KB of state` : 'differs');
  check('The opened project is named after the file, clean, with no undo history',
    loaded.name === 'Round Trip' && loaded.shown === 'Round Trip' && !loaded.dirty && loaded.undo === 0 && loaded.selected === null && !loaded.playing, JSON.stringify(loaded));

  // 5. The specifics people care about
  const detail = await page.evaluate((ids) => {
    const s = window.__dawStore.getState();
    const choir = s.tracks.find((t) => t.id === ids.choir);
    const kit = s.tracks.find((t) => t.id === ids.kit);
    return {
      sound: choir.instrument.parameters.Library.sound.name, length: choir.instrument.parameters.Library.sound.length,
      kick: kit.instrument.parameters.Library.sounds['kick-808'].name, kitId: kit.instrument.parameters.Library.kit.id,
      feedback: choir.plugins.find((p) => p.id === ids.device)?.parameters.Feedback,
      volume: choir.automation.volume, lanes: choir.automationLanes, send: choir.sends[ids.ret], fader: choir.volume,
      session: s.sessionClips[ids.choir]?.[1]?.file, scene: s.scenes[1], quant: s.launchQuantization,
      audio: s.regions.find((r) => r.file === 'sine.wav')?.audioBuffer?.length, midi: s.regions.find((r) => r.notes?.length === 3)?.notes.map((n) => n.pitch),
      sig: s.timeSignatures, bpm: s.bpm
    };
  }, built);
  check('Library recipes and their edits survive', detail.sound === 'Edited Choir' && detail.length === 3.25 && detail.kick === 'Edited Kick' && detail.kitId === 'kit-808', JSON.stringify(detail).slice(0, 160));
  check('Device settings, automation, sends and faders survive',
    detail.feedback === 61 && detail.volume.length === 2 && detail.volume[1].value === 0.3 && detail.lanes.join() === 'volume,pan' && detail.send === 0.35 && detail.fader === 0.55,
    JSON.stringify({ feedback: detail.feedback, volume: detail.volume, send: detail.send }));
  check('Clips, session clips, scenes, tempo and time signatures survive',
    detail.audio === 4410 && detail.midi.join() === '60,64,67' && detail.session === 'Hook' && detail.scene.name === 'Chorus' && detail.scene.tempo === 110 && detail.scene.follow.bars === 4 && detail.quant === '1/4' && detail.bpm === 96 && JSON.stringify(detail.sig).includes('"numerator":3'),
    JSON.stringify({ audio: detail.audio, midi: detail.midi, session: detail.session, scene: detail.scene, bpm: detail.bpm }));

  // 6. A loaded library sound renders exactly as the original does
  const render = await page.evaluate((id) => {
    const { render, LIBRARY } = window.__sound;
    const loadedSound = window.__dawStore.getState().tracks.find((t) => t.id === id).instrument.parameters.Library.sound;
    const original = { ...LIBRARY.find((r) => r.id === 'pad-choir'), name: 'Edited Choir', length: 3.25 };
    const a = render(loadedSound, { note: 60, sampleRate: 22050 }), b = render(original, { note: 60, sampleRate: 22050 });
    let same = a.left.length === b.left.length, peak = 0;
    for (let i = 0; same && i < a.left.length; i++) { if (a.left[i] !== b.left[i]) same = false; peak = Math.max(peak, Math.abs(a.left[i])); }
    return { same, peak, length: a.left.length };
  }, built.choir);
  check('A loaded sound renders bit for bit like the one that was saved', render.same && render.peak > 0.05, JSON.stringify(render));

  // 7. Loaded tracks make sound: play the choir from the keyboard path
  const audible = await page.evaluate(async (id) => {
    const inputs = await import('/src/audio/inputs.ts');
    const st = window.__dawStore.getState();
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    await window.__transport.audioContext.resume();
    let peak = 0;
    const end = performance.now() + 1500;
    inputs.publishMidi({ type: 'on', pitch: 60, velocity: 0.9, channel: 1, source: 'test', time: window.__transport.audioContext.currentTime, targets: [id] });
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    inputs.publishMidi({ type: 'off', pitch: 60, velocity: 0, channel: 1, source: 'test', time: window.__transport.audioContext.currentTime, targets: [id] });
    return peak;
  }, built.choir);
  check('The loaded instrument plays', audible > 0.01, audible.toFixed(3));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l)); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
