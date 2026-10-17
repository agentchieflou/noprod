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

  // A tempo that moves continuously (the Tempo Follower, a drag): 30 changes in
  // a second render each clip at most twice, and the final tempo's render plays
  const flood = await page.evaluate(async () => {
    const { stretchedBuffer } = window.__warp;
    const { scheduleClip } = window.__clips;
    let posted = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) { if (m && m.channels && m.options) posted++; return post.call(this, m, t); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30; i++) { window.__dawStore.getState().setBpmLive(100 + i); await sleep(33); }
    const bpm = 129;
    const region = window.__dawStore.getState().regions.at(-1);
    const start = performance.now();
    while (!stretchedBuffer(region, bpm) && performance.now() - start < 10000) await sleep(50);
    await sleep(500); // anything still queued would post by now
    Worker.prototype.postMessage = post;
    const rendered = stretchedBuffer(region, bpm);
    const offline = new OfflineAudioContext(2, 48000, 48000);
    const sources = scheduleClip(offline, region, null, offline.destination, 0, 0, 1, bpm).length;
    return { posted, duration: rendered ? rendered.duration : 0, sources };
  });
  check('30 tempo changes in a second render the clip at most twice', flood.posted <= 2, `${flood.posted} renders`);
  check('...and the final tempo\'s render plays', flood.sources === 1 && Math.abs(flood.duration - 2 * 120 / 129) < 0.001,
    `${flood.sources} sources, render ${flood.duration.toFixed(3)} s`);

  // Renders are kept within a memory budget, the least recently used dropped
  const memory = await page.evaluate(async () => {
    const { stretchedBuffer, stretchStats, setStretchBudget } = window.__warp;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const region = () => window.__dawStore.getState().regions.at(-1);
    const first = stretchedBuffer(region(), 129);
    const each = first.length * first.numberOfChannels * 4;
    const normal = stretchStats().budget;
    setStretchBudget(Math.floor(each * 2.5));
    let worst = 0;
    for (const bpm of [90, 100, 110]) {
      window.__dawStore.getState().setBpmLive(bpm);
      const start = performance.now();
      while (!stretchedBuffer(region(), bpm) && performance.now() - start < 10000) await sleep(50);
      worst = Math.max(worst, stretchStats().bytes);
    }
    const after = stretchStats();
    setStretchBudget(normal);
    return { worst, budget: Math.floor(each * 2.5), renders: after.renders, normal };
  });
  check('Renders stay within their memory budget, the oldest dropped', memory.worst <= memory.budget && memory.renders === 2,
    `${(memory.worst / 1e6).toFixed(2)} MB held of ${(memory.budget / 1e6).toFixed(2)} MB, ${memory.renders} kept (the app's budget: ${(memory.normal / 2 ** 20).toFixed(0)} MB)`);

  // A render bigger than the whole budget is kept (the newest always is):
  // it plays, and isn't rendered again while the clip plays
  const big = await page.evaluate(async () => {
    const { stretchedBuffer, stretchStats, setStretchBudget } = window.__warp;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const region = () => window.__dawStore.getState().regions.at(-1);
    const normal = stretchStats().budget;
    setStretchBudget(1000);
    const before = stretchStats().started;
    window.__dawStore.getState().setBpmLive(105);
    const start = performance.now();
    while (!stretchedBuffer(region(), 105) && performance.now() - start < 10000) await sleep(50);
    window.__transport.setPosition(0);
    window.__dawStore.getState().togglePlayback();
    await sleep(1000);
    const a = window.__transport.masterAnalyser;
    const data = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(data);
    const level = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    await sleep(2000);
    window.__dawStore.getState().togglePlayback();
    const ready = !!stretchedBuffer(region(), 105);
    const started = stretchStats().started - before;
    setStretchBudget(normal);
    return { started, ready, level };
  });
  check('A render bigger than the budget plays, and is rendered once', big.started === 1 && big.ready && big.level > 0.005,
    `${big.started} renders over 3 s of playback, ${big.ready ? 'kept' : 'gone'}, RMS ${big.level.toFixed(4)}`);

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
    // (the Clip View loads on first use)
    const find = () => [...document.querySelectorAll('.clip-view select')].find((s) => [...s.options].some((o) => o.value === 'repitch'));
    for (let i = 0; i < 100 && !find(); i++) await new Promise((r) => setTimeout(r, 50));
    const select = find();
    return select ? { value: select.value, options: [...select.options].map((o) => o.value) } : null;
  });
  check('The Clip View\'s warp modes include Complex, and it is selected', options && options.options.includes('complex') && options.value === 'complex', JSON.stringify(options));

  await ctx.sleep(300);
  await ctx.shot('warp');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
