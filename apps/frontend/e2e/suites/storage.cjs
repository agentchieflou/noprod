// #136: the v2 project file, autosave and recovery, storage failures
const { writeFileSync } = require('node:fs');
const { gzipSync } = require('node:zlib');
const { join } = require('node:path');

module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = "") => { const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`; results.push(line); console.log(line); };
  const url = page.url();
  await page.mouse.click(5, 5);

  // In the page: a buffer of known samples, and a checksum to compare by
  const helpers = (p = page) => p.evaluate(async () => {
    const { audioContext } = await import('/src/audio/engine.ts');
    window.__tone = (seconds, channels = 2, sr = 48000) => {
      const b = audioContext.createBuffer(channels, Math.round(seconds * sr), sr);
      for (let c = 0; c < channels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * (0.01 + c * 0.003)) * 0.5; }
      return b;
    };
    // Noise: IndexedDB compresses what it stores, and a tone shrinks too well
    window.__noise = (seconds, sr = 48000) => {
      const b = audioContext.createBuffer(2, Math.round(seconds * sr), sr);
      for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() - 0.5; }
      return b;
    };
    window.__sum = (b) => { let s = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 7) s += d[i] * ((i % 13) + 1); } return `${b.numberOfChannels}x${b.length}@${b.sampleRate}:${s.toFixed(6)}`; };
  });
  // The autosave slots, as stored
  const slots = (p = page) => p.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('noprod');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('slots')) { db.close(); resolve([]); return; }
      const g = db.transaction('slots').objectStore('slots').getAll();
      g.onsuccess = () => {
        db.close();
        resolve(g.result.map((s) => { const d = JSON.parse(s.json); return { key: s.key, tabId: s.tabId, bpm: d.project.bpm, regions: d.project.regions.length, buffers: d.buffers.length }; }));
      };
    };
  }));
  const banners = (p = page) => p.evaluate(() => [...document.querySelectorAll('.recovery-banner')].map((b) => b.textContent));
  const menu = async (label, p = page) => {
    await p.evaluate(() => document.querySelector('.file-menu-btn').click());
    await ctx.sleep(100);
    await p.evaluate((l) => [...document.querySelectorAll('.file-menu-list button')].find((b) => b.textContent.startsWith(l)).click(), label);
  };
  await helpers();

  // 1. The schema knows every project key the store saves
  const keys = await page.evaluate(async () => {
    const { PROJECT_KEYS } = await import('/src/store/useDAWStore.js');
    const { SCHEMA_KEYS } = await import('/src/project/schema.ts');
    return { store: [...PROJECT_KEYS].sort(), schema: [...SCHEMA_KEYS].sort() };
  });
  check('The schema covers every project key in the store', JSON.stringify(keys.store) === JSON.stringify(keys.schema), JSON.stringify(keys));

  // 2. A round trip through the worker: buffers come back bit for bit, still shared
  const trip = await page.evaluate(async () => {
    const { serializeProject, deserializeProject } = await import('/src/project/projectFile.ts');
    const { audioContext } = await import('/src/audio/engine.ts');
    const st = window.__dawStore.getState();
    const long = window.__tone(120);
    const short = window.__tone(0.5, 1, 44100);
    const state = {
      ...st,
      regions: [
        { id: 'r1', trackId: 'track-audio-1', file: 'Long', audioBuffer: long, startTime: 0, duration: 120 },
        { id: 'r2', trackId: 'track-audio-1', file: 'Long', audioBuffer: long, startTime: 130, duration: 120 }
      ],
      sessionClips: { 'track-audio-1': { 0: { id: 'c', file: 'Short', audioBuffer: short, duration: 0.5 } } },
      tracks: st.tracks.map((t, i) => (i === 0 ? { ...t, isFrozen: true, frozenBuffer: short } : t))
    };
    const t0 = performance.now();
    const blob = await serializeProject(state);
    const saveMs = performance.now() - t0;
    const head = [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())];
    const back = await deserializeProject(blob, audioContext);
    return {
      size: blob.size, head, saveMs,
      same: window.__sum(back.regions[0].audioBuffer) === window.__sum(long) && window.__sum(back.sessionClips['track-audio-1'][0].audioBuffer) === window.__sum(short),
      shared: back.regions[0].audioBuffer === back.regions[1].audioBuffer && back.tracks[0].frozenBuffer === back.sessionClips['track-audio-1'][0].audioBuffer
    };
  });
  check('Saved as a v2 container of raw PCM', trip.head.join() === '137,78,80,82,74,13,10,26' && trip.size > 120 * 48000 * 8, `${(trip.size / 1e6).toFixed(1)} MB in ${trip.saveMs.toFixed(0)} ms`);
  check('Two minutes of stereo audio round-trip bit for bit, shared buffers still shared', trip.same && trip.shared, JSON.stringify(trip));

  // 3. Opening files: a v1 file loads; damaged ones are refused, nothing loaded
  const take = new Float32Array(4800).map((_, i) => Math.sin(i / 10));
  const v1 = {
    format: 'noprod-project', version: 1, savedAt: '2026-10-10T00:00:00Z',
    project: await page.evaluate(() => { const st = window.__dawStore.getState(); const p = {}; ['bpm', 'timeSignatures', 'countInBars', 'masterVolume', 'masterPan', 'returns', 'masterPlugins', 'isLimiterEnabled', 'isLoopEnabled', 'loopStart', 'loopEnd', 'locators', 'punchInTime', 'punchOutTime', 'isPunchEnabled', 'vstScanPaths', 'tracks', 'regions', 'sessionClips', 'savedRacks'].forEach((k) => { p[k] = st[k]; }); return p; }),
    buffers: { buf0: { sampleRate: 48000, length: 4800, channels: [Buffer.from(take.buffer).toString('base64')] } }
  };
  v1.project.bpm = 97;
  v1.project.regions = [{ id: 'r1', trackId: 'track-audio-1', file: 'Old Take', audioBuffer: { $audioBuffer: 'buf0' }, startTime: 0, duration: 0.1 }];
  writeFileSync(join(ctx.fixtures, 'Old Song.noprod'), gzipSync(JSON.stringify(v1)));
  writeFileSync(join(ctx.fixtures, 'Broken.noprod'), gzipSync(JSON.stringify({ ...v1, project: { ...v1.project, tracks: null } })));
  const input = await page.$('input[type=file][accept=".noprod"]');
  await input.uploadFile(join(ctx.fixtures, 'Old Song.noprod'));
  await ctx.sleep(1500);
  const opened = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const b = st.regions[0]?.audioBuffer;
    return { name: st.projectName, bpm: st.bpm, scenes: st.scenes.length, frames: b?.length, first: b?.getChannelData(0)[10] };
  });
  check('A v1 file opens, with the keys it predates filled in', opened.name === 'Old Song' && opened.bpm === 97 && opened.scenes === 8 && opened.frames === 4800 && Math.abs(opened.first - Math.sin(1)) < 1e-6, JSON.stringify(opened));
  const dialogs = ctx.logs.filter((l) => l.startsWith('[dialog]')).length;
  await input.uploadFile(join(ctx.fixtures, 'Broken.noprod'));
  await ctx.sleep(1500);
  const refused = { said: ctx.logs.filter((l) => l.startsWith('[dialog]')).slice(dialogs), bpm: await page.evaluate(() => window.__dawStore.getState().bpm) };
  check('A damaged file is refused with a clear message and nothing loaded', refused.bpm === 97 && refused.said.some((l) => /Could not open project: .*tracks: expected a list/.test(l)), JSON.stringify(refused));

  // 4. Autosave runs while playing, and a reload offers the work back
  await page.evaluate(() => window.__dawStore.getState().newProject());
  await ctx.sleep(300);
  const takeSum = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setBpm(133);
    st.togglePlayback();
    const buf = window.__tone(3);
    st.addRegion({ trackId: 'track-audio-1', file: 'Take', audioBuffer: buf, startTime: 0, duration: buf.duration });
    return window.__sum(buf);
  });
  await ctx.sleep(2500);
  const whilePlaying = await slots();
  await page.evaluate(() => { if (window.__dawStore.getState().isPlaying) window.__dawStore.getState().togglePlayback(); });
  const mine = whilePlaying.find((s) => s.bpm === 133);
  check('Autosave writes while playing, take included', !!mine && mine.regions === 1 && mine.buffers === 1, JSON.stringify(whilePlaying));

  await page.reload({ waitUntil: 'networkidle0' });
  await helpers();
  await ctx.sleep(1000);
  const offered = await banners();
  check('After a reload the unsaved project is offered back', offered.length === 1 && /Untitled.*can be recovered/.test(offered[0]), JSON.stringify(offered));
  await page.evaluate(() => [...document.querySelectorAll('.recovery-banner button')].find((b) => b.textContent === 'Restore').click());
  await ctx.sleep(1500);
  const restored = await page.evaluate(() => {
    const st = window.__dawStore.getState();
    return { bpm: st.bpm, sum: st.regions[0] && window.__sum(st.regions[0].audioBuffer), dirty: !st.savedSnapshot, banners: document.querySelectorAll('.recovery-banner').length };
  });
  check('Restore brings back the project and its take, still unsaved', restored.bpm === 133 && restored.sum === takeSum && restored.dirty && restored.banners === 0, JSON.stringify(restored));

  // 5. Two tabs keep separate copies; a tab's copy is offered once it closes
  const tabB = await page.browser().newPage();
  tabB.on('pageerror', (e) => ctx.logs.push(`[pageerror] ${e.message}`));
  tabB.on('dialog', (d) => d.accept());
  await tabB.goto(url, { waitUntil: 'networkidle0' });
  await ctx.sleep(1000);
  const bOffered = await banners(tabB);
  await tabB.evaluate(() => window.__dawStore.getState().setBpm(91));
  await page.evaluate(() => window.__dawStore.getState().setBpm(134));
  await ctx.sleep(2500);
  const both = await slots();
  const a = both.find((s) => s.bpm === 134), b = both.find((s) => s.bpm === 91);
  check('Two tabs keep separate recovery copies', both.length === 2 && a && b && a.tabId !== b.tabId, JSON.stringify(both));
  check('A tab is not offered the copy of a tab that is still open', bOffered.length === 0, JSON.stringify(bOffered));

  // Save in browsers without File System Access: a named download, said so
  await tabB.evaluate(() => {
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push(this.download); };
  });
  await tabB.evaluate(() => { window.showSaveFilePicker = undefined; window.__dawStore.getState().markSaved('My Song'); window.__dawStore.getState().setBpm(92); });
  // re-render the menu so it sees the browser can't save in place
  await tabB.evaluate(() => document.querySelector('.file-menu-btn').click());
  await ctx.sleep(100);
  const label = await tabB.evaluate(() => [...document.querySelectorAll('.file-menu-list button')].map((x) => x.textContent).find((t) => t.startsWith('Save')));
  await tabB.evaluate(() => [...document.querySelectorAll('.file-menu-list button')].find((x) => x.textContent.startsWith('Save')).click());
  await ctx.sleep(1500);
  const dl = await tabB.evaluate(() => ({ files: window.__downloads, status: document.querySelector('.file-status')?.textContent, dirty: !window.__dawStore.getState().savedSnapshot || window.__dawStore.getState().bpm !== window.__dawStore.getState().savedSnapshot.bpm }));
  check('Without File System Access, Save downloads “<project>.noprod” and says so', /download/.test(label) && dl.files[0] === 'My Song.noprod' && /Downloaded “My Song\.noprod”/.test(dl.status || '') && !dl.dirty, `${label} / ${JSON.stringify(dl)}`);
  await ctx.sleep(500);
  const afterSave = await slots();
  check('Saving drops that tab\'s recovery copy', afterSave.length === 1 && afterSave[0].bpm === 134, JSON.stringify(afterSave));

  await tabB.evaluate(() => window.__dawStore.getState().setBpm(93));
  await ctx.sleep(2500);
  await tabB.close();
  await page.reload({ waitUntil: 'networkidle0' });
  await helpers();
  await ctx.sleep(1000);
  const nowOffered = await banners();
  check('Once the other tab closes, its copy is offered too', nowOffered.length === 2, JSON.stringify(nowOffered));
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => [...document.querySelectorAll('.recovery-banner button')].find((b) => b.textContent === 'Discard').click());
    await ctx.sleep(300);
  }
  await ctx.sleep(300);
  check('Discard removes recovery copies', (await slots()).length === 0 && (await banners()).length === 0);
  await page.evaluate(() => window.__dawStore.getState().setBpm(150));
  await ctx.sleep(2500);
  const had = await slots();
  await menu('New Project');
  await ctx.sleep(800);
  const left = await slots();
  check('New Project drops the recovery copy of the project it replaces', had.length === 1 && left.length === 0, JSON.stringify({ had, left }));

  // 6. A full disk is shown, and clears once there is room again. Chrome
  // applies a quota override only to storage opened after it, so this runs
  // in a fresh browser context.
  const fresh = await page.browser().createBrowserContext();
  const tabC = await fresh.newPage();
  tabC.on('pageerror', (e) => ctx.logs.push(`[pageerror] ${e.message}`));
  const cdp = await tabC.target().createCDPSession();
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(url).origin, quotaSize: 1024 * 1024 });
  await tabC.goto(url, { waitUntil: 'networkidle0' });
  await helpers(tabC);
  await ctx.sleep(500);
  await tabC.evaluate(() => {
    const st = window.__dawStore.getState();
    const buf = window.__noise(10);
    st.addRegion({ trackId: 'track-audio-1', file: 'Big', audioBuffer: buf, startTime: 0, duration: buf.duration });
  });
  await ctx.sleep(2500);
  const full = await tabC.evaluate(() => document.querySelector('.storage-banner')?.textContent || '');
  check('A quota error is shown to the user', /Autosave: browser storage is full/.test(full), full || JSON.stringify(await slots(tabC)));
  await tabC.screenshot({ path: join(ctx.shotDir, 'project-quota.png') });
  // Make room: lift the quota. Chrome counts an aborted write against it
  // until it cleans up, so freeing a little isn't enough; the worker reopens
  // its connection after the failure and so sees the new quota.
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(url).origin });
  let cleared = null;
  for (let i = 0; i < 6; i++) {
    await tabC.evaluate((bpm) => window.__dawStore.getState().setBpm(bpm), 140 + i);
    await ctx.sleep(2000);
    cleared = { banner: await tabC.evaluate(() => !!document.querySelector('.storage-banner')), slots: await slots(tabC), tries: i + 1 };
    if (!cleared.banner) break;
  }
  if (cleared.banner) cleared.notice = await tabC.evaluate(() => document.querySelector('.storage-banner').textContent);
  check('Once there is room, autosave saves the work that failed and the notice clears', !cleared.banner && cleared.slots.some((s) => s.bpm >= 140 && s.regions === 1 && s.buffers === 1), JSON.stringify(cleared));
  await fresh.close();

  // 7. My Sounds: stored with a schema version; export and import
  const recipe = await page.evaluate(async () => {
    const { findSound } = await import(window.__fs + '/packages/sound/src/index.ts');
    return { ...findSound('marimba'), id: 'my-imported', name: 'Imported Marimba' };
  });
  writeFileSync(join(ctx.fixtures, 'sounds.json'), JSON.stringify({ format: 'noprod-sounds', version: 1, sounds: [recipe] }));
  writeFileSync(join(ctx.fixtures, 'bad-sounds.json'), JSON.stringify({ format: 'noprod-sounds', version: 1, sounds: [{ ...recipe, layers: [{ type: 'laser' }] }] }));
  const soundsInput = await page.$('input[type=file][accept^=".json"]');
  await soundsInput.uploadFile(join(ctx.fixtures, 'sounds.json'));
  await ctx.sleep(800);
  const stored = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('noprod-sounds');
    r.onsuccess = () => {
      const g = r.result.transaction('sounds').objectStore('sounds').get('my-imported');
      g.onsuccess = () => { r.result.close(); resolve({ version: g.result?.version, name: g.result?.recipe?.name, dbVersion: r.result.version }); };
    };
  }));
  const listed = await page.evaluate(async () => (await import('/src/audio/userSounds.ts')).getUserSounds().map((s) => s.name));
  check('Imported sounds join My Sounds, stored with a schema version', listed.includes('Imported Marimba') && stored.version === 1 && stored.name === 'Imported Marimba' && stored.dbVersion === 2, JSON.stringify({ listed, stored }));
  const before = ctx.logs.filter((l) => l.startsWith('[dialog]')).length;
  await soundsInput.uploadFile(join(ctx.fixtures, 'bad-sounds.json'));
  await ctx.sleep(800);
  const badSaid = ctx.logs.filter((l) => l.startsWith('[dialog]')).slice(before);
  check('A malformed sounds file is refused', badSaid.some((l) => /Could not import sounds: Sound 1 .*unknown type "laser"/.test(l)), JSON.stringify(badSaid));
  await page.evaluate(() => {
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push(fetch(this.href).then((r) => r.text()).then((text) => ({ name: this.download, text }))); };
  });
  await menu('Export My Sounds');
  await ctx.sleep(500);
  const exported = await page.evaluate(async () => { const d = await window.__downloads[0]; return { name: d.name, doc: JSON.parse(d.text) }; });
  check('My Sounds export as a versioned file', exported.name.endsWith('.json') && exported.doc.format === 'noprod-sounds' && exported.doc.version === 1 && exported.doc.sounds.some((s) => s.id === 'my-imported'), exported.name);

  await ctx.shot('project');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));

  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
