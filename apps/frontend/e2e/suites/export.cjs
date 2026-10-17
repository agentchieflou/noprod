// #159 step 3: offline render and export. A project with devices renders
// through the same mixer as playback: two renders are the same to the
// sample, the stems sum to the mix, an offline render matches a realtime
// capture, the devices' tail is rendered and trimmed, a cancel stops the
// render, and the Export dialog writes WAV files.
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  await page.evaluate(async () => { window.__sound = await import(window.__fs + '/packages/sound/src/index.ts'); return 1; });
  await page.evaluate(async () => { window.__render = await import('/src/audio/render.ts'); return 1; });
  await page.evaluate(async () => { window.__export = await import('/src/audio/export.ts'); return 1; });
  await page.evaluate(async () => { window.__clips = await import('/src/audio/clipPlayback.ts'); return 1; });
  await page.evaluate(async () => { window.__devices = await import('/src/audio/devices.ts'); return 1; });
  await page.evaluate(async () => { window.__tr = await import('/src/audio/transport.ts'); return 1; });
  await page.evaluate(async () => { await window.__tr.engineReady(); return 1; });
  // A render that never resolves fails its check instead of stalling the suite
  await page.evaluate(() => {
    window.__timed = (promise, what, ms = 60000) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} hung for ${ms / 1000} s`)), ms))]);
    return 1;
  });

  // A project: two synth tracks of eighth notes for two bars (4 s at 120),
  // the first through a delay and a compressor with a volume lane, the
  // second through a reverb, and a return with a delay fed by both sends
  await page.evaluate(() => {
    const store = () => window.__dawStore.getState();
    const { createDevice } = window.__devices;
    store().setBpm(120);
    const synth = (gain) => ({ name: 'Synth', type: 'instrument', parameters: { Waveform: 'sawtooth', Attack: 0.005, Decay: 0.1, Sustain: 0.6, Release: 0.05, Gain: gain } });
    const notes = (base) => Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, pitch: base + [0, 4, 7, 12][i % 4], start: i * 0.25, duration: 0.2, velocity: 0.8 }));
    store().addMidiTrackWithInstrument(synth(0.4), 'E2E keys');
    const a = store().tracks.at(-1).id;
    store().addMidiRegion(a, 0, 4, notes(60));
    store().addMidiTrackWithInstrument(synth(0.3), 'E2E bass');
    const b = store().tracks.at(-1).id;
    store().addMidiRegion(b, 0, 4, notes(36));
    // ids as the store's addDevice would give them: a device is its own DSP
    const delay = { ...createDevice('delay'), id: 'e2e-delay', parameters: { Time: 0.375, Feedback: 50, 'Dry/Wet': 25 } };
    const comp = { ...createDevice('compressor'), id: 'e2e-comp' };
    const reverb = { ...createDevice('reverb'), id: 'e2e-reverb', parameters: { 'Dry/Wet': 35, Decay: 1.5 } };
    const echo = { ...createDevice('delay'), id: 'e2e-echo', parameters: { Time: 0.25, Feedback: 30, 'Dry/Wet': 100 } };
    window.__dawStore.setState({
      tracks: store().tracks.map((t) => t.id === a ? { ...t, plugins: [delay, comp], automation: { volume: [{ time: 0, value: 0.9 }, { time: 2, value: 0.4 }, { time: 4, value: 0.9 }] } }
        : t.id === b ? { ...t, plugins: [reverb], sends: { ...(t.sends || {}), [store().returns[0].id]: 0.3 } } : t),
      returns: store().returns.map((r, i) => (i === 0 ? { ...r, plugins: [echo] } : r))
    });
    store().setSelectedTrackId(null);
    window.__ids = { a, b };
    return 1;
  });
  const sampleRate = await page.evaluate(() => window.__transport.audioContext.sampleRate);

  // 1. Two renders of the mix are the same to the sample
  const twice = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    const t0 = performance.now();
    const one = await window.__timed(window.__render.renderProject({ state: st, from: 0, to: 4, sampleRate: window.__transport.audioContext.sampleRate }), 'the first render');
    const ms = performance.now() - t0;
    const two = await window.__timed(window.__render.renderProject({ state: st, from: 0, to: 4, sampleRate: window.__transport.audioContext.sampleRate }), 'the second render');
    const a = one.buffers[0], b = two.buffers[0];
    let differ = 0, peak = 0;
    for (let c = 0; c < 2; c++) {
      const x = a.getChannelData(c), y = b.getChannelData(c);
      for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) differ++; peak = Math.max(peak, Math.abs(x[i])); }
    }
    window.__mix = a;
    return { differ, length: a.length, sameLength: a.length === b.length, seconds: +(a.length / a.sampleRate).toFixed(2), tail: +one.tail.toFixed(2), peak: +peak.toFixed(3), ms: Math.round(ms) };
  });
  check('Two renders of the mix, devices and automation included, are the same to the sample', twice.differ === 0 && twice.sameLength && twice.peak > 0.05,
    `${twice.differ} of ${twice.length * 2} samples differ; ${twice.seconds} s rendered for 4 s of music (tail ${twice.tail} s, trimmed); peak ${twice.peak}; ${twice.ms} ms (${(4000 / twice.ms).toFixed(1)}× realtime)`);
  check('…and the devices\' tail runs past the end', twice.tail >= 1.5 && twice.seconds > 4.2 && twice.seconds <= 4 + twice.tail + 0.01, `${twice.seconds} s, tail ${twice.tail} s`);

  // 2. The stems sum to the mix (the master at unity, no master devices, the limiter off)
  const stems = await page.evaluate(async () => {
   try {
    const store = () => window.__dawStore.getState();
    window.__dawStore.setState({ isLimiterEnabled: false, masterVolume: 1 });
    const st = store();
    const sr = window.__transport.audioContext.sampleRate;
    const ids = window.__render.stemIds(st);
    const mix = (await window.__timed(window.__render.renderProject({ state: st, from: 0, to: 4, sampleRate: sr, tail: 0 }), 'the mix')).buffers[0];
    const parts = (await window.__timed(window.__render.renderProject({ state: st, from: 0, to: 4, sampleRate: sr, stems: ids, tail: 0 }), 'the stems')).buffers;
    const data = parts.map((p) => [p.getChannelData(0), p.getChannelData(1)]);
    let worst = 0, energy = 0, audible = 0;
    for (let c = 0; c < 2; c++) {
      const m = mix.getChannelData(c);
      for (let i = 0; i < m.length; i++) {
        let sum = 0;
        for (const d of data) sum += d[c][i];
        worst = Math.max(worst, Math.abs(sum - m[i]));
        energy += m[i] * m[i];
      }
    }
    for (const p of parts) { let e = 0; const x = p.getChannelData(0); for (let i = 0; i < x.length; i += 7) e += x[i] * x[i]; if (e > 0) audible++; }
    return { stems: ids.length, audible, worst, rms: Math.sqrt(energy / (2 * mix.length)) };
   } catch (e) { return { error: e.message, stems: 0, audible: 0, worst: Infinity, rms: 0 }; }
  });
  check('The stems (the top-level tracks and the returns) sum to the mix', stems.worst < 1e-4 && stems.audible >= 3 && stems.rms > 0.01,
    stems.error || `${stems.stems} stems, ${stems.audible} audible; the sum is within ${stems.worst.toExponential(1)} of the mix (mix rms ${stems.rms.toFixed(3)})`);

  // 3. An offline render matches a realtime capture of the same project: the
  // master recorded by a worklet while it plays from 0, aligned on the
  // first sample above the floor. The limiter stays off: the native
  // DynamicsCompressor's envelope starts cold offline and warm live (about
  // 20 dB apart), which step 5's own limiter settles.
  const realtime = await page.evaluate(async (sampleRate) => {
    const ctxA = window.__transport.audioContext;
    window.__mix = (await window.__timed(window.__render.renderProject({ state: window.__dawStore.getState(), from: 0, to: 4, sampleRate: ctxA.sampleRate, tail: 0 }), 'the mix')).buffers[0];
    const code = `class Rec extends AudioWorkletProcessor {
      constructor() { super(); this.chunks = []; this.on = false; this.port.onmessage = (e) => { if (e.data === 'start') { this.chunks = []; this.on = true; } else { this.on = false; this.port.postMessage(this.chunks); } }; }
      process(inputs) { const ch = inputs[0] && inputs[0][0]; if (this.on && ch) this.chunks.push(Float32Array.from(ch)); return true; }
    }
    registerProcessor('e2e-rec', Rec);`;
    await ctxA.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    const rec = new AudioWorkletNode(ctxA, 'e2e-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctxA.createGain(); sink.gain.value = 0;
    window.__transport.masterAnalyser.connect(rec); rec.connect(sink); sink.connect(ctxA.destination);
    const ask = (m) => new Promise((r) => { rec.port.onmessage = (e) => r(e.data); rec.port.postMessage(m); });
    await ctxA.resume();
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    window.__transport.setPosition(0);
    window.__tr.getScheduler().claim();
    rec.port.postMessage('start');
    window.__dawStore.getState().togglePlayback();
    await new Promise((r) => setTimeout(r, 4600));
    window.__dawStore.getState().togglePlayback();
    const chunks = await ask('stop');
    const taken = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0; for (const c of chunks) { taken.set(c, at); at += c.length; }
    const offline = window.__mix.getChannelData(0);
    const first = (x) => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-3) return i; return -1; };
    const i0 = first(taken), j0 = first(offline);
    const n = Math.min(4 * sampleRate - 1000, taken.length - i0, offline.length - j0);
    let diff = 0, energy = 0;
    for (let k = 0; k < n; k++) { const d = taken[i0 + k] - offline[j0 + k]; diff += d * d; energy += offline[j0 + k] * offline[j0 + k]; }
    return { startedAt: i0, compared: n, dB: 10 * Math.log10(diff / energy), captured: +(taken.length / sampleRate).toFixed(2) };
  }, sampleRate);
  check('An offline render matches a realtime capture: the difference is 30 dB under the signal or more', realtime.startedAt >= 0 && realtime.compared > 3 * sampleRate && realtime.dB < -30,
    `${(realtime.compared / sampleRate).toFixed(2)} s compared from the first sound, difference ${realtime.dB.toFixed(1)} dB (${realtime.captured} s captured)`);

  // 4. Progress reports and a cancel stops the render at the next window
  const cancel = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    const progress = [];
    const controller = new AbortController();
    const t0 = performance.now();
    let outcome = 'resolved';
    try {
      await window.__render.renderProject({ state: st, from: 0, to: 4, sampleRate: window.__transport.audioContext.sampleRate, onProgress: (p) => { progress.push(+p.toFixed(2)); if (progress.length === 2) controller.abort(); }, signal: controller.signal });
    } catch (e) { outcome = e.name; }
    return { outcome, progress, ms: Math.round(performance.now() - t0) };
  });
  check('Progress is reported window by window, and a cancel stops the render', cancel.outcome === 'AbortError' && cancel.progress.length >= 2 && cancel.progress.length <= 3 && cancel.progress[0] > 0,
    `${cancel.outcome} after progress ${cancel.progress.join(', ')} in ${cancel.ms} ms`);

  // 5. The Export dialog, from the File menu: it lists the stems, and an
  // export is a WAV the package can decode, dithered at 16 bits
  await page.evaluate(() => { [...document.querySelectorAll('.file-menu-btn')][0].click(); return 1; });
  await ctx.sleep(100);
  await page.evaluate(() => { document.querySelector('.file-menu-export').click(); return 1; });
  await page.waitForSelector('.export-dialog', { timeout: 5000 });
  const dialog = await page.evaluate(() => {
    const d = document.querySelector('.export-dialog');
    return { what: [...d.querySelectorAll('select')][0].options[1].textContent, start: !!d.querySelector('.export-start') && !d.querySelector('.export-start').disabled };
  });
  check('Export Audio… in the File menu opens the dialog, offering the mix and the stems', /Stems: \d+ files, zipped/.test(dialog.what) && dialog.start, dialog.what);
  const wav = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    const { clipTimelineLength } = window.__clips;
    const r = await window.__export.exportProject({ state: st, what: 'mix', range: 'project', bits: 16, sampleRate: 48000, tail: 0 }, clipTimelineLength);
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    const { sampleRate, channels } = window.__sound.decodeWav(bytes);
    const z = await window.__export.exportProject({ state: st, what: 'stems', range: 'project', bits: 24, sampleRate: 44100, tail: 0 }, clipTimelineLength);
    return { name: r.name, files: r.files, bytes: bytes.length, sampleRate, channels: channels.length, seconds: +(channels[0].length / sampleRate).toFixed(2), zipName: z.name, zipFiles: z.files, zipBytes: z.blob.size, type: z.blob.type };
  });
  check('The mix exports as a 16-bit WAV at the chosen rate, the stems as a zip of WAVs',
    wav.name.endsWith('.wav') && wav.files === 1 && wav.sampleRate === 48000 && wav.channels === 2 && wav.seconds === 4 && wav.zipFiles >= 3 && wav.type === 'application/zip' && wav.zipBytes > 100000,
    `${wav.name}: ${wav.bytes} bytes, ${wav.sampleRate} Hz, ${wav.channels} channels, ${wav.seconds} s; ${wav.zipName}: ${wav.zipFiles} files, ${wav.zipBytes} bytes`);
  await ctx.shot('export');
  await page.evaluate(() => { document.querySelector('.export-dialog .btn-icon').click(); return 1; });

  const errors = ctx.logs.filter((l) => /^\[(pageerror|error)\]/.test(l) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
};
