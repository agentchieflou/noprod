// Browser support: the startup check, the small-screen notice, recording
// latency without outputLatency, Firefox's MIDI and plugin-scan notes, and
// project files without CompressionStream
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  await page.evaluate(async () => { window.__support = await import('/src/platform/support.ts'); return 1; });
  await page.evaluate(async () => { window.__latency = await import('/src/audio/latency.ts'); return 1; });

  // 1. The startup check
  const checks = await page.evaluate(() => {
    const s = window.__support;
    const ok = { AudioContext: class {}, AudioWorkletNode: class {}, isSecureContext: true };
    return {
      ok: s.missingFeatures(ok),
      insecure: s.missingFeatures({ ...ok, isSecureContext: false }),
      noWorklet: s.missingFeatures({ ...ok, AudioWorkletNode: undefined }),
      noAudio: s.missingFeatures({ isSecureContext: true }),
      here: s.missingFeatures(),
      firefox: s.isFirefox('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),
      chrome: s.isFirefox('Mozilla/5.0 Chrome/140.0 Safari/537.36'),
    };
  });
  check('A browser with what noprod needs passes the check', checks.ok.length === 0 && checks.here.length === 0);
  check('An insecure page is named', checks.insecure.length === 1 && /secure context/.test(checks.insecure[0]), checks.insecure.join());
  check('A missing AudioWorklet is named', checks.noWorklet.length === 1 && /AudioWorklet/.test(checks.noWorklet[0]), checks.noWorklet.join());
  check('A missing Web Audio is named', checks.noAudio.length === 1 && /Web Audio/.test(checks.noAudio[0]), checks.noAudio.join());
  check('Firefox is recognised by its user agent', checks.firefox === true && checks.chrome === false);

  // The page itself, in a browser without AudioWorklet
  const bare = await page.browser().newPage();
  await bare.evaluateOnNewDocument(() => { delete window.AudioWorkletNode; });
  await bare.goto(page.url(), { waitUntil: 'networkidle0' });
  const unsupported = await bare.evaluate(() => ({ text: document.querySelector('.unsupported')?.textContent ?? '', daw: !!document.querySelector('.daw-container') }));
  check('A browser without AudioWorklet gets a page saying why', /can't run/.test(unsupported.text) && /AudioWorklet/.test(unsupported.text) && !unsupported.daw, unsupported.text.slice(0, 80));
  await bare.close();

  // 2. The small-screen notice
  const noticeShown = () => page.evaluate(() => !!document.querySelector('.small-screen-notice'));
  check('A wide window has no notice', !(await noticeShown()));
  await page.setViewport({ width: 800, height: 700 });
  await ctx.sleep(300);
  check('Below 900 px a notice appears', await noticeShown());
  const fit = await page.evaluate(() => {
    const n = document.querySelector('.small-screen-notice').getBoundingClientRect();
    return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, noticeW: n.width, noticeH: n.height, innerH: window.innerHeight };
  });
  check('The notice fits the viewport', fit.scrollW <= fit.innerW && fit.noticeW <= fit.innerW && fit.noticeH <= fit.innerH, JSON.stringify(fit));
  await ctx.shot('small-screen-notice');
  await page.setViewport({ width: 390, height: 700 });
  await ctx.sleep(300);
  const phone = await page.evaluate(() => {
    const n = document.querySelector('.small-screen-notice');
    const r = n.getBoundingClientRect();
    return { noticeW: r.width, innerW: window.innerWidth, contentW: n.scrollWidth, textRight: Math.max(...[...n.children].map((c) => c.getBoundingClientRect().right)) };
  });
  check('The notice and its text fit a phone', phone.noticeW <= phone.innerW && phone.contentW <= phone.innerW && phone.textRight <= phone.innerW, JSON.stringify(phone));
  await page.evaluate(() => [...document.querySelectorAll('.small-screen-notice button')].find((b) => /Continue anyway/.test(b.textContent))?.click());
  await ctx.sleep(200);
  check('"Continue anyway" dismisses it', !(await noticeShown()));
  await page.setViewport({ width: 1600, height: 1000 });
  await ctx.sleep(200);

  // 3. Recording latency
  const lat = await page.evaluate(() => {
    const l = window.__latency;
    try { localStorage.removeItem('noprod.extraLatencyMs'); } catch { /* blocked */ }
    const withOutput = l.playbackLatencySeconds({ baseLatency: 0.01, outputLatency: 0.03 });
    const without = l.playbackLatencySeconds({ baseLatency: 0.01 });
    l.setExtraLatencyMs(50);
    const custom = l.playbackLatencySeconds({ baseLatency: 0.01 });
    l.setExtraLatencyMs(30);
    return { withOutput, without, custom, has: l.hasOutputLatency({ outputLatency: 0 }), hasNot: l.hasOutputLatency({}) };
  });
  check('outputLatency is used when the browser has it', Math.abs(lat.withOutput - 0.04) < 1e-9 && lat.has, String(lat.withOutput));
  check('Without it, base latency plus the default estimate', Math.abs(lat.without - 0.04) < 1e-9 && !lat.hasNot, String(lat.without));
  check('The estimate is a setting', Math.abs(lat.custom - 0.06) < 1e-9, String(lat.custom));

  // 4. Plugin scanning where there is no folder picker, and the latency note
  await page.evaluate(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); });
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'VST Folders Scan').click());
  await ctx.sleep(300);
  const scan = await page.evaluate(() => ({
    button: [...document.querySelectorAll('button')].some((b) => /Scan Folder for Plugins/.test(b.textContent)),
    note: document.querySelector('.vst-paths-view .browser-note')?.textContent ?? '',
    latency: [...document.querySelectorAll('.browser-note')].map((n) => n.textContent).join(' '),
  }));
  check('Without a folder picker the scan button gives way to a reason', !scan.button && /plugin scanning is off/.test(scan.note), scan.note.slice(0, 70));
  check('Settings says which latency recordings use', /output latency/.test(scan.latency), scan.latency.slice(0, 80));
  await ctx.shot('browser-notes');

  // 5. MIDI refused
  await page.evaluate(async () => { window.__inputs = await import('/src/audio/inputs.ts'); return 1; });
  const midi = await page.evaluate(async () => {
    const i = window.__inputs;
    const before = i.getMidiStatus();
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: () => Promise.reject(new DOMException('denied', 'SecurityError')), configurable: true });
    await i.initMidi();
    return { before, after: i.getMidiStatus() };
  });
  check('A refused MIDI request is recorded', midi.before === 'idle' && midi.after === 'denied', JSON.stringify(midi));
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
    document.querySelector('.io-toggle').click();
    return 1;
  });
  await ctx.sleep(300);
  await ctx.shot('midi-refused');
  const midiNote = await page.evaluate(() => [...document.querySelectorAll('.browser-note')].map((n) => n.textContent).find((t) => /MIDI blocked/.test(t)) ?? '');
  check('The MIDI input says why, and what to do', /MIDI blocked/.test(midiNote) && /(Allow MIDI|site-permission add-on)/.test(midiNote), midiNote.slice(0, 80));

  // 6. Project files without CompressionStream (#136's v2 file: project.json
  // goes in plain, flagged so, and v1's plain JSON files still load)
  await page.evaluate(async () => { window.__pf = await import('/src/project/projectFile.ts'); return 1; });
  await page.evaluate(async () => { window.__format = await import('/src/project/format.ts'); return 1; });
  await page.evaluate(async () => { window.__store = await import('/src/store/useDAWStore.js'); return 1; });
  const file = await page.evaluate(async () => {
    const pf = window.__pf, format = window.__format;
    const flagsOf = async (blob) => new DataView(await blob.slice(16, 32).arrayBuffer()).getUint32(4, true);
    const normal = await pf.serializeProject(window.__dawStore.getState());
    const v2 = [...new Uint8Array(await normal.slice(0, 8).arrayBuffer())].join() === '137,78,80,82,74,13,10,26';
    const { json } = pf.snapshotProject(window.__dawStore.getState());
    const saved = [window.CompressionStream, window.DecompressionStream];
    delete window.CompressionStream;
    delete window.DecompressionStream;
    let plainFlags, tracks;
    try {
      const plain = await format.writeProjectFile(json, []);
      plainFlags = await flagsOf(plain);
      const back = await format.readProjectFile(plain, window.__store.createDefaultProject());
      tracks = back.doc.project.tracks.length;
    } finally { [window.CompressionStream, window.DecompressionStream] = saved; }
    const st = window.__dawStore.getState();
    const v1plain = new Blob([JSON.stringify({ format: 'noprod-project', version: 1, project: Object.fromEntries(['bpm', 'timeSignatures', 'countInBars', 'masterVolume', 'masterPan', 'returns', 'masterPlugins', 'isLimiterEnabled', 'isLoopEnabled', 'loopStart', 'loopEnd', 'locators', 'punchInTime', 'punchOutTime', 'isPunchEnabled', 'vstScanPaths', 'tracks', 'regions', 'sessionClips', 'savedRacks'].map((k) => [k, st[k]])), buffers: {} })]);
    const fromV1 = await pf.deserializeProject(v1plain, window.__transport.audioContext);
    return { v2, gzFlags: await flagsOf(normal), plainFlags, tracks, v1Tracks: fromV1.tracks.length, want: st.tracks.length };
  });
  check('Normally project.json is gzipped inside the file', file.v2 && file.gzFlags === 1, JSON.stringify(file));
  check('Without CompressionStream it is stored plain, and loads without DecompressionStream', file.plainFlags === 0 && file.tracks === file.want, JSON.stringify(file));
  check('A plain-JSON v1 file still loads', file.v1Tracks === file.want, JSON.stringify(file));

  check('Nothing used an alert', dialogs.length === 0, dialogs.join(' | '));
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
