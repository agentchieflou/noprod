// #160: warped audio clips stretched by our phase vocoder, in a worker
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  // A 2 s harmonic tone at 220 Hz, recorded at 120 BPM, warped (Complex) on an audio track
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.addTrack('audio');
    const track = window.__dawStore.getState().tracks.at(-1);
    const sr = window.__transport.audioContext.sampleRate;
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: 2 * sr, sampleRate: sr });
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        let v = 0;
        for (let h = 1; h <= 6; h++) v += (0.15 / h) * Math.sin((2 * Math.PI * 220 * h * i) / sr + h);
        data[i] = v * Math.min(1, i / 480, (data.length - i) / 480);
      }
    }
    window.__dawStore.getState().addRegion({
      trackId: track.id, type: 'audio', file: 'Tone', audioBuffer: buffer, startTime: 0, duration: 2,
      warpEnabled: true, warpMode: 'complex', originalBpm: 120
    });
  });

  // The app's modules and the package, kept on the page (one import per call)
  await page.evaluate(async () => { window.__clips = await import('/src/audio/clipPlayback.ts'); return 1; });
  await page.evaluate(async () => { window.__warp = await import('/src/audio/warp.ts'); return 1; });
  await page.evaluate(async () => { window.__S = await import(window.__fs + '/packages/sound/src/index.ts'); return 1; });

  // At a new tempo, the clip renders in the worker; the grains play until it's ready
  const fallback = await page.evaluate(() => {
    const { scheduleClip } = window.__clips;
    window.__dawStore.getState().setBpm(96);
    const st = window.__dawStore.getState();
    const region = st.regions.at(-1);
    const offline = new OfflineAudioContext(2, 48000, 48000);
    return scheduleClip(offline, region, null, offline.destination, 0, 0, 1, 96).length;
  });
  check('Before the render is ready, the clip plays as grains', fallback > 10, `${fallback} sources for 1 s`);

  const waited = await page.evaluate(async () => {
    const { stretchedBuffer } = window.__warp;
    const region = window.__dawStore.getState().regions.at(-1);
    const start = performance.now();
    while (!stretchedBuffer(region, 96) && performance.now() - start < 10000) await new Promise((r) => setTimeout(r, 50));
    const b = stretchedBuffer(region, 96);
    return { ms: performance.now() - start, length: b ? b.duration : 0 };
  });
  check('The stretched render arrives from the worker', waited.length > 0, `${waited.ms.toFixed(0)} ms, ${waited.length.toFixed(3)} s long`);

  // Rendered offline as the transport schedules it: the right length and the right pitch
  const measured = await page.evaluate(async () => {
    const S = window.__S;
    const { scheduleClip, clipTimelineLength } = window.__clips;
    const region = window.__dawStore.getState().regions.at(-1);
    const length = clipTimelineLength(region, 96);
    const sr = 48000;
    const offline = new OfflineAudioContext(2, Math.ceil((length + 0.5) * sr), sr);
    const sources = scheduleClip(offline, region, null, offline.destination, 0, 0, length, 96);
    const out = (await offline.startRendering()).getChannelData(0);
    let last = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 0.01) last = i;
    const pitch = S.analysis.estimatePitch(out, sr, Math.round(1.2 * sr), 8192);
    // How steady the level is: grains wobble, a phase vocoder holds
    const levels = [0.4, 0.8, 1.2, 1.6, 2.0].map((t) => S.analysis.levelAt(out, sr, t, 0.05));
    return { sources: sources.length, length, end: last / sr, pitch, wobble: 20 * Math.log10(Math.max(...levels) / Math.min(...levels)) };
  });
  check('The clip is 2.5 s on the timeline at 96 BPM', Math.abs(measured.length - 2.5) < 1e-9, `${measured.length} s`);
  check('Once rendered, it plays the render (one source)', measured.sources === 1, `${measured.sources} sources`);
  check('It sounds for its whole new length', Math.abs(measured.end - 2.5) < 0.02, `ends at ${measured.end.toFixed(3)} s`);
  check('It keeps its pitch', Math.abs(1200 * Math.log2(measured.pitch / 220)) < 5, `${measured.pitch.toFixed(2)} Hz`);
  check('Its level holds steady', measured.wobble < 0.5, `${measured.wobble.toFixed(2)} dB across the clip`);

  // Transposed, it renders shifted, at the same length
  const shifted = await page.evaluate(async () => {
    const S = window.__S;
    const { scheduleClip, clipTimelineLength } = window.__clips;
    const { stretchedBuffer } = window.__warp;
    const st = window.__dawStore.getState();
    st.updateClip(st.regions.at(-1).id, { transpose: 7 });
    const region = window.__dawStore.getState().regions.at(-1);
    const start = performance.now();
    while (!stretchedBuffer(region, 96) && performance.now() - start < 10000) await new Promise((r) => setTimeout(r, 50));
    const length = clipTimelineLength(region, 96);
    const offline = new OfflineAudioContext(2, Math.ceil((length + 0.5) * 48000), 48000);
    scheduleClip(offline, region, null, offline.destination, 0, 0, length, 96);
    const out = (await offline.startRendering()).getChannelData(0);
    return { length, pitch: S.analysis.estimatePitch(out, 48000, Math.round(1.2 * 48000), 8192) };
  });
  const want = 220 * 2 ** (7 / 12);
  check('Transposed +7, it plays a fifth up at the same length', Math.abs(1200 * Math.log2(shifted.pitch / want)) < 5 && Math.abs(shifted.length - 2.5) < 1e-9,
    `${shifted.pitch.toFixed(2)} Hz (want ${want.toFixed(2)}), ${shifted.length} s`);

  // Played by the transport, it's audible on the master
  const heard = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    window.__transport.setPosition(0.5);
    st.togglePlayback();
    await new Promise((r) => setTimeout(r, 700));
    const a = window.__transport.masterAnalyser;
    const data = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(data);
    const level = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    const now = window.__dawStore.getState();
    now.togglePlayback();
    return level;
  });
  check('Played by the transport, it is audible', heard > 0.005, `RMS ${heard.toFixed(4)}`);

  // The Clip View offers the stretcher's modes
  const options = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    st.setSelectedRegionId(st.regions.at(-1).id);
    [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Clip View').click();
    await new Promise((r) => setTimeout(r, 300));
    const select = [...document.querySelectorAll('.clip-view select')].find((s) => [...s.options].some((o) => o.value === 'repitch'));
    return select ? { value: select.value, options: [...select.options].map((o) => o.value) } : null;
  });
  check('The Clip View\'s warp modes include Complex, and it is selected', options && options.options.includes('complex') && options.value === 'complex', JSON.stringify(options));

  await ctx.sleep(300);
  await ctx.shot('warp');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
