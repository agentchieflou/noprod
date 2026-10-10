// #63: library sounds and kits through the Browser, every note path, drag and drop, and project files
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  // Resume the context with a click (autoplay flag is on anyway)
  await page.mouse.click(5, 5);

  // 1. The Browser lists the library in groups
  const groups = await page.$$eval('.browser-folder', (els) => els.map((e) => e.textContent.trim()));
  check('Browser shows library groups', ['Drum Kits', 'Drums', 'Percussion'].every((g) => groups.some((t) => t.startsWith(g))), groups.slice(0, 5).join(' | '));

  // 2. Open Drum Kits and double-click the 808 Kit
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Drum Kits')).click());
  await ctx.sleep(100);
  const before = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.browser-item')].find((e) => e.textContent.trim() === '808 Kit');
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await ctx.sleep(200);
  const kitTrack = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks[st.tracks.length - 1];
    const p = t.instrument.parameters;
    return { count: st.tracks.length, id: t.id, kit: p.Kit, kitId: p.Library?.kit?.id, sounds: Object.keys(p.Library?.sounds || {}).length, hasKick: !!p.Library?.sounds?.['kick-808'] };
  });
  check('Double-clicking a kit adds a MIDI track playing it', kitTrack.count === before + 1 && kitTrack.kit === 'library' && kitTrack.kitId === 'kit-808' && kitTrack.hasKick, JSON.stringify(kitTrack));

  // 3. The instrument card shows the kit's pads by sound name
  await page.evaluate((id) => window.__dawStore.getState().setSelectedTrackId(id), kitTrack.id);
  await ctx.sleep(200);
  const card = await page.evaluate(() => ({
    label: document.querySelector('.instrument-card .device-card-header span')?.textContent,
    pads: [...document.querySelectorAll('.instrument-card .drum-pad')].map((b) => b.textContent)
  }));
  check('Instrument card shows a library kit and its pads', card.label === 'LIBRARY · KIT' && card.pads.includes('808 Kick') && card.pads.includes('Acoustic Snare') && card.pads.includes('Low Floor Tom'), `${card.label} / ${card.pads.slice(0, 6).join(', ')}`);

  // Level at the master over the next `ms` milliseconds
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

  // 4. Auditioning a pad is heard at the master
  await page.evaluate(() => [...document.querySelectorAll('.instrument-card .drum-pad')].find((b) => b.textContent === '808 Kick').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const auditionPeak = await listen(400);
  check('A pad sounds at the master', auditionPeak > 0.05, `peak ${auditionPeak.toFixed(3)}`);
  await ctx.sleep(1500);

  // 5. A clip on the kit track: warmup renders its notes before playback
  const warm = await page.evaluate(async (trackId) => {
    const st = window.__dawStore.getState();
    const notes = [36, 42, 38, 42, 36, 46, 38, 42].map((pitch, i) => ({ id: `n${i}`, pitch, start: i * 0.25, duration: 0.2, velocity: 0.9 }));
    st.addMidiRegion(trackId, 0, 2, notes);
    await new Promise((r) => setTimeout(r, 1500)); // warmup debounce + renders
    const { triggerNote } = await import('/src/audio/synth.ts');
    const { audioContext } = await import('/src/audio/engine.ts');
    const sink = audioContext.createGain(); // not connected: silent
    const params = window.__dawStore.getState().tracks.find((t) => t.id === trackId).instrument.parameters;
    const t0 = performance.now();
    for (const n of notes) triggerNote(audioContext, sink, params, n.pitch, audioContext.currentTime + 5, n.duration, n.velocity).stop();
    return performance.now() - t0;
  }, kitTrack.id);
  check('Warmup renders clip notes ahead (8 notes trigger from cache)', warm < 15, `${warm.toFixed(1)} ms`);

  // 6. Playing the arrangement plays the kit
  await page.evaluate(() => { window.__transport.setPosition(0); window.__dawStore.getState().togglePlayback(); });
  const playPeak = await listen(1200);
  await page.evaluate(() => window.__dawStore.getState().togglePlayback());
  check('Arrangement playback plays the kit', playPeak > 0.05, `peak ${playPeak.toFixed(3)}`);

  // 7. Freeze path: the same clip in an OfflineAudioContext
  const offline = await page.evaluate(async (trackId) => {
    const { scheduleClip } = await import('/src/audio/clipPlayback.ts');
    const st = window.__dawStore.getState();
    const track = st.tracks.find((t) => t.id === trackId);
    const region = st.regions.find((r) => r.trackId === trackId);
    const off = new OfflineAudioContext(2, 44100 * 3, 44100);
    scheduleClip(off, region, track.instrument.parameters, off.destination, 0, 0, 2, st.bpm, {});
    const out = await off.startRendering();
    const d = out.getChannelData(0);
    let peak = 0; for (const x of d) peak = Math.max(peak, Math.abs(x));
    // the open hat (46 at 1.25 s) is choked by the closed hat at 1.75 s
    let after = 0; for (let i = Math.round(1.8 * 44100); i < Math.round(1.95 * 44100); i++) after = Math.max(after, Math.abs(d[i]));
    return { peak, after };
  }, kitTrack.id);
  check('Freeze (offline) renders the kit', offline.peak > 0.1, `peak ${offline.peak.toFixed(3)}`);

  // 8. Hat choke: closed hat cuts the open hat
  const choke = await page.evaluate(async () => {
    const { triggerNote } = await import('/src/audio/synth.ts');
    const { KITS, findSound } = await import(window.__fs + '/packages/sound/src/index.ts');
    const { kitSounds } = await import('/src/audio/library.ts');
    const kit = KITS.find((k) => k.id === 'kit-808');
    const params = { Kit: 'library', Gain: 1, Tune: 0, Library: { kit, sounds: kitSounds(kit) } };
    const level = async (withClosed) => {
      const off = new OfflineAudioContext(2, 44100, 44100);
      triggerNote(off, off.destination, params, 46, 0, 0.1, 1);
      if (withClosed) triggerNote(off, off.destination, params, 42, 0.15, 0.1, 0.01); // nearly silent closed hat
      const d = (await off.startRendering()).getChannelData(0);
      let peak = 0; for (let i = Math.round(0.22 * 44100); i < Math.round(0.35 * 44100); i++) peak = Math.max(peak, Math.abs(d[i]));
      return peak;
    };
    return { open: await level(false), choked: await level(true), hasSound: !!findSound('hat-808-open') };
  });
  check('A closed hat chokes an open hat', choke.open > 0.01 && choke.choked < choke.open * 0.05, JSON.stringify(choke));

  // 9. Computer keyboard switches to drums for a library kit
  const mode = await page.evaluate(async () => (await import('/src/audio/computerKeyboard.ts')).effectiveMode(window.__dawStore.getState()));
  check('Computer keyboard plays drums on a library kit', mode === 'drums', mode);

  // 10. A pitched-sound instrument (library sound on a MIDI track) follows the note; live voice releases
  const pitched = await page.evaluate(async () => {
    const { startVoice } = await import('/src/audio/synth.ts');
    const { analysis } = await import(window.__fs + '/packages/sound/src/index.ts');
    const sound = { id: 'test-tone', name: 'Test Tone', category: 'leads', pitched: true, root: 60, length: 2,
      layers: [{ type: 'partials', partials: [{ ratio: 1, level: 1 }], env: { sustain: 1, release: 0.1 } }] };
    const params = { Kit: 'library', Gain: 1, Tune: 0, Library: { sound } };
    const off = new OfflineAudioContext(2, 44100, 44100);
    const v = startVoice(off, off.destination, params, 69, 0, 1);
    v.release(0.5);
    const d = (await off.startRendering()).getChannelData(0);
    return { hz: analysis.estimatePitch(d, 44100, 4410, 4096), held: analysis.levelAt(d, 44100, 0.3), after: analysis.levelAt(d, 44100, 0.8) };
  });
  check('A library sound plays the note held, then releases', Math.abs(pitched.hz - 440) < 1 && pitched.held > 0.1 && pitched.after < pitched.held * 0.01, JSON.stringify(pitched));

  // 11. Dropping a sound: a MIDI track takes it as its instrument, an audio track as a clip
  const drops = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    st.addTrack('audio');
    const audio = window.__dawStore.getState().tracks.at(-1);
    const midi = window.__dawStore.getState().tracks.find((t) => t.type === 'midi');
    const lanes = [...document.querySelectorAll('.arranger-track')];
    const tracks = window.__dawStore.getState().tracks.filter((t) => !t.parentId || true);
    const drop = (lane, id) => {
      const dt = new DataTransfer();
      dt.setData('application/x-noprod-sound', id);
      const r = lane.getBoundingClientRect();
      lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 100, clientY: r.top + 5 }));
    };
    await new Promise((r) => setTimeout(r, 200));
    const laneFor = (id) => [...document.querySelectorAll('.arranger-track')][window.__dawStore.getState().tracks.findIndex((t) => t.id === id)];
    drop(laneFor(audio.id), 'clap');
    drop(laneFor(midi.id), 'snare-brush');
    await new Promise((r) => setTimeout(r, 300));
    const after = window.__dawStore.getState();
    const region = after.regions.find((r) => r.trackId === audio.id);
    return {
      lanes: lanes.length, tracks: tracks.length,
      region: region ? { file: region.file, duration: +region.duration.toFixed(2), channels: region.audioBuffer?.numberOfChannels } : null,
      midiInstrument: after.tracks.find((t) => t.id === midi.id).instrument.parameters.Library?.sound?.id
    };
  });
  check('Dropping a sound on an audio track adds it as a clip', drops.region?.file === 'Clap' && drops.region.channels === 2 && drops.region.duration > 0.2, JSON.stringify(drops));
  check('Dropping a sound on a MIDI track makes it the instrument', drops.midiInstrument === 'snare-brush', drops.midiInstrument);

  // 12. A project file keeps the recipes
  const saved = await page.evaluate(async () => {
    const { serializeProject, deserializeProject } = await import('/src/project/projectFile.ts');
    const { audioContext } = await import('/src/audio/engine.ts');
    const blob = await serializeProject(window.__dawStore.getState());
    const project = await deserializeProject(blob, audioContext);
    const kit = project.tracks.find((t) => t.instrument?.parameters?.Library?.kit);
    return { kit: kit?.instrument.parameters.Library.kit.id, kick: kit?.instrument.parameters.Library.sounds['kick-808']?.layers?.length, size: blob.size };
  });
  check('Saved projects keep library recipes', saved.kit === 'kit-808' && saved.kick > 0, JSON.stringify(saved));

  // 13. Previewing sounds and kits from the Browser doesn't throw
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Drums')).click());
  await ctx.sleep(100);
  await page.evaluate(() => {
    [...document.querySelectorAll('.browser-item')].find((e) => e.textContent.trim() === '808 Kick').click();
    [...document.querySelectorAll('.browser-item')].find((e) => e.textContent.trim() === 'Lo-Fi Kit').click();
  });
  await ctx.sleep(500);
  await ctx.shot('library_browser');

  // 14. Prewarming a pad clip renders in the worker: the page stays responsive
  const jank = await page.evaluate(async () => {
    const { LIBRARY } = await import(window.__fs + '/packages/sound/src/index.ts');
    const { createLibraryInstrument } = await import('/src/audio/library.ts');
    const st = window.__dawStore.getState();
    st.addMidiTrackWithInstrument(createLibraryInstrument(LIBRARY.find((r) => r.id === 'pad-choir')), 'Choir');
    const track = window.__dawStore.getState().tracks.at(-1);
    const { prewarmPending } = await import('/src/audio/library.ts');
    window.__dawStore.getState().addMidiRegion(track.id, 0, 4, [55, 59, 62, 66, 69, 71].map((pitch, i) => ({ id: `c${i}`, pitch, start: 0, duration: 3.5, velocity: 0.8 })));
    // measure from when the warmup starts (300 ms after the change), past React's re-render
    await new Promise((r) => setTimeout(r, 350));
    let last = performance.now(), worst = 0;
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const began = performance.now();
    while (prewarmPending() > 0 && performance.now() - began < 30000) await new Promise((r) => setTimeout(r, 50));
    const took = Math.round(performance.now() - began);
    clearInterval(timer);
    // 15. ...and the selected pad's keys are ready to play live
    const { startVoice } = await import('/src/audio/synth.ts');
    const { audioContext } = await import('/src/audio/engine.ts');
    const sink = audioContext.createGain();
    const params = window.__dawStore.getState().tracks.find((t) => t.id === track.id).instrument.parameters;
    const t0 = performance.now();
    for (const pitch of [50, 60, 70]) startVoice(audioContext, sink, params, pitch, audioContext.currentTime, 0.8).release(audioContext.currentTime);
    return { worst: Math.round(worst), took, live: +(performance.now() - t0).toFixed(1), selected: window.__dawStore.getState().selectedTrackId === track.id };
  });
  check('Prewarming a pad keeps the page responsive (worker)', jank.worst < 60, `longest stall ${jank.worst} ms while rendering 31 notes in ${jank.took} ms`);
  check('The selected pad is ready to play live', jank.selected && jank.live < 15, `3 keys in ${jank.live} ms`);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080')); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
