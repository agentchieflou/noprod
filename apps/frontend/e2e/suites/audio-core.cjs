// #134: the Audio Core (GhostDAW) from the browser: pairing with the code it
// printed, the scan, a plug-in on the master bus and its parameters, the
// pairing surviving a reload, and unpairing. Then, from this process as a
// client would: the hosted app's origin pairs, other origins and a wrong
// token are refused at the handshake, and a LOAD_PLUGIN by path is refused.
// A plug-in on a track keeps its whole state in the project (#216): the
// chunk GhostDAW reports is saved with the device and sent back with LOAD.
// The runner starts GhostDAW on the null audio backend with the LPI test
// gain's folder registered (ctx.ghostdaw: its pairing code).
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

// Opens a track stream as the bridge would and sends `messages` in order;
// resolves with the replies once there is one per message
const streamProbe = (url, messages, ms = 5000) => new Promise((done) => {
  const result = { opened: false, status: null, replies: [] };
  const ws = new WebSocket(url);
  const finish = () => { clearTimeout(timer); try { ws.close(); } catch {} done(result); };
  const timer = setTimeout(finish, ms);
  ws.on('unexpected-response', (_req, res) => { result.status = res.statusCode; finish(); });
  ws.on('error', () => finish());
  ws.on('open', () => { result.opened = true; messages.forEach((m) => ws.send(JSON.stringify(m))); });
  ws.on('message', (data) => { result.replies.push(JSON.parse(data.toString())); if (result.replies.length >= messages.length) setTimeout(finish, 200); });
});

// Opens a control connection as a client of `origin` would (none: a
// program) and sends `message` once open; resolves with what happened
const probe = (url, origin, message, ms = 5000) => new Promise((done) => {
  const result = { opened: false, status: null, replies: [] };
  const ws = new WebSocket(url, origin ? { origin } : {});
  const finish = () => { clearTimeout(timer); try { ws.close(); } catch {} done(result); };
  const timer = setTimeout(finish, ms);
  ws.on('unexpected-response', (_req, res) => { result.status = res.statusCode; finish(); });
  ws.on('error', () => finish());
  ws.on('open', () => { result.opened = true; if (message) ws.send(JSON.stringify(message)); else finish(); });
  ws.on('message', (data) => { result.replies.push(JSON.parse(data.toString())); if (result.replies.length >= (message ? 1 : 0)) setTimeout(finish, 200); });
});

module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const core = () => page.evaluate(() => {
    const s = window.__audioCore();
    return { connected: s.connected, needsPairing: s.needsPairing, pairing: s.pairing, pairingError: s.pairingError, error: s.error, busy: s.busy,
      plugins: s.state?.availablePlugins?.map((p) => `${p.format}:${p.name}`) ?? [], scanning: !!s.state?.scanning,
      master: s.state?.buses?.find((b) => b.bus === 'master')?.inserts ?? [], sampleRate: s.state?.sampleRate, protocolVersion: s.state?.protocolVersion };
  });
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await ctx.sleep(100); }
    return false;
  };
  const setInput = (sel, value, type = 'input') => page.evaluate((sel, value, type) => {
    const el = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }, sel, value, type);
  const panelText = () => page.evaluate(() => document.querySelector('.native-host')?.textContent ?? '');
  await page.mouse.click(5, 5);

  // 1. A fresh browser is not paired: GhostDAW is up, the panel asks for the code
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'VST Folders Scan').click());
  check('GhostDAW is reachable but this browser is not paired', await until(async () => (await core()).needsPairing), JSON.stringify(await core()));
  // (the tab's panel loads lazily)
  check('The panel asks for the pairing code', await until(async () => /not paired/.test(await panelText()) && !!(await page.$('.native-pairing-code'))), await panelText());

  // 2. A wrong code is refused, with the attempts left
  await setInput('.native-pairing-code', 'ZZZZ-ZZZZ');
  await page.click('.native-pairing button[type="submit"]');
  check('A wrong code is refused with the attempts left', await until(async () => /Wrong code, 4 attempts left/.test((await core()).pairingError ?? '')), (await core()).pairingError);

  // 3. The right code pairs: the connection that paired stays, the state arrives, the token is kept
  await setInput('.native-pairing-code', ctx.ghostdaw.pairingCode);
  await page.click('.native-pairing button[type="submit"]');
  check('The code GhostDAW printed pairs the browser', await until(async () => { const c = await core(); return c.connected && !!c.sampleRate; }), JSON.stringify(await core()));
  const paired = await core();
  check('The state is the new protocol\'s, from the null audio device', paired.protocolVersion === 2 && paired.sampleRate > 0, JSON.stringify(paired));
  check('The panel shows paired and the sample rate', /● paired · \d+(\.\d+)? kHz/.test(await panelText()), await panelText());
  const token = await page.evaluate(() => localStorage.getItem('noprod.ghostdaw.token'));
  check('The token is kept in localStorage', /^[0-9a-f]{64}$/.test(token ?? ''), String(token).slice(0, 12));

  // 4. A scan lists the LPI test gain from the folder GhostDAW was given (never one the page names)
  await page.evaluate(() => [...document.querySelectorAll('.native-host button')].find((b) => /Scan Folders/.test(b.textContent)).click());
  check('A scan finds the test plug-in through the scan worker', await until(async () => (await core()).plugins.includes('LPI:NoProd Test Gain'), 30000), (await core()).plugins.join(', '));
  check('The scan is done (no longer busy)', await until(async () => { const c = await core(); return !c.busy && !c.scanning; }), JSON.stringify(await core()));

  // 5. The plug-in on the master bus, by id, and a parameter change answered with the plug-in's text
  await page.evaluate(() => [...document.querySelectorAll('.native-available .vst-path-row')].find((r) => /NoProd Test Gain/.test(r.textContent)).querySelector('button').click());
  check('Adding it puts an insert on the master bus', await until(async () => (await core()).master.length === 1), JSON.stringify((await core()).master));
  const insert = (await core()).master[0];
  check('The insert is the LPI gain with its two parameters', insert?.format === 'LPI' && insert?.name === 'NoProd Test Gain' && insert?.parameters?.length === 2 && insert.parameters[0].id === 'gain', JSON.stringify(insert));
  await ctx.sleep(200);
  await setInput('.native-insert .param-slider', '0.5');
  check('A slider change comes back with the plug-in\'s text', await until(async () => { const p = (await core()).master[0]?.parameters?.[0]; return p && Math.abs(p.value - 0.5) < 1e-6 && /0\.5/.test(p.text); }), JSON.stringify((await core()).master[0]?.parameters?.[0]));
  await ctx.shot('audio-core');

  // 5b. A plug-in on a track keeps its whole state in the project: the chunk
  // GhostDAW reports is saved with the device and sent back with its LOAD,
  // so what no parameter sets (the test gain's preset name) survives
  const streamPort = await page.evaluate(() => window.__audioCore().state?.streamPort);
  const deviceId = await page.evaluate(async () => {
    const { approveNativePlugin } = await import('/src/native/consent.ts');
    const st = window.__dawStore.getState();
    const device = { name: 'NoProd Test Gain', type: 'vst', pluginId: 'com.noprod.test.gain', format: 'LPI', parameters: {} };
    approveNativePlugin(device);
    st.addDeviceToTrack(st.tracks[0].id, device);
    const plugins = window.__dawStore.getState().tracks[0].plugins;
    return plugins[plugins.length - 1].id;
  });
  const bridge = (id) => page.evaluate(async (id) => {
    const s = (await import('/src/native/trackBridge.ts')).getNativeDeviceState(id);
    return s ? { connected: s.connected, state: s.state, gain: s.insert?.parameters?.[0]?.value ?? null } : null;
  }, id);
  const deviceChunk = (id) => page.evaluate((id) => window.__dawStore.getState().tracks[0].plugins.find((p) => p.id === id)?.state ?? null, id);
  check('A track device loads its plug-in by id and reads the plug-in\'s state back', await until(async () => typeof (await bridge(deviceId))?.state === 'string'), JSON.stringify(await bridge(deviceId)));
  // The chunk as a preset would set it: gain 0.25, mute off, then the preset name
  const chunk = Buffer.concat([Buffer.from(new Float32Array([0.25, 0]).buffer), Buffer.from('verse')]).toString('base64');
  await page.evaluate((id, chunk) => window.__dawStore.getState().setNativeDeviceState(id, chunk), deviceId, chunk);
  check('The chunk is kept with the device', (await deviceChunk(deviceId)) === chunk, String(await deviceChunk(deviceId)));
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
  check('The project saves with the device', !!file && file.name.endsWith('.noprod'), file ? file.name : 'no download');
  await page.click('.file-menu-btn');
  await page.evaluate(() => { [...document.querySelectorAll('.file-menu-list button')].find((b) => b.textContent === 'New Project').click(); return 1; });
  check('A new project unloads it', await until(async () => (await bridge(deviceId)) === null));
  const saved = path.join(ctx.fixtures, 'State Trip.noprod');
  fs.writeFileSync(saved, Buffer.from(file.bytes));
  await (await page.$('.file-menu input[type=file]')).uploadFile(saved);
  check('Opening the project loads the plug-in again', await until(async () => typeof (await bridge(deviceId))?.state === 'string'), JSON.stringify(await bridge(deviceId)));
  const back = await bridge(deviceId);
  const decoded = Buffer.from(back?.state ?? '', 'base64');
  check('The plug-in got the project\'s chunk: the preset name no parameter sets, and the gain it held',
    decoded.length === 13 && decoded.subarray(8).toString() === 'verse' && Math.abs(decoded.readFloatLE(0) - 0.25) < 1e-6 && Math.abs((back?.gain ?? 0) - 0.25) < 1e-6,
    `${decoded.toString('hex')} gain ${back?.gain}`);
  check('The opened project still holds its chunk, unchanged', (await deviceChunk(deviceId)) === chunk && !(await page.evaluate(async () => (await import('/src/store/useDAWStore.js')).isProjectDirty(window.__dawStore.getState()))), String(await deviceChunk(deviceId)));
  await page.evaluate((id) => { const st = window.__dawStore.getState(); st.updateDeviceParameter(st.tracks[0].id, id, 'gain', 0.75); }, deviceId);
  check('After a parameter change the device takes the plug-in\'s new state, the name still in it',
    await until(async () => { const c = await deviceChunk(deviceId); if (!c || c === chunk) return false; const d = Buffer.from(c, 'base64'); return Math.abs(d.readFloatLE(0) - 0.75) < 1e-6 && d.subarray(8).toString() === 'verse'; }),
    String(await deviceChunk(deviceId)));
  await page.evaluate((id) => { const st = window.__dawStore.getState(); st.removeDeviceFromTrack(st.tracks[0].id, id); }, deviceId);

  // 6. A reload connects with the kept token: paired without a code, the insert still there
  await page.reload({ waitUntil: 'networkidle0', timeout: 120000 });
  await page.mouse.click(5, 5);
  check('After a reload the browser is paired without a code', await until(async () => (await core()).connected && !!(await core()).sampleRate), JSON.stringify(await core()));
  check('The insert is still on the master bus', await until(async () => (await core()).master.length === 1 && (await core()).master[0].name === 'NoProd Test Gain'), JSON.stringify((await core()).master));

  // 7. Unpairing forgets the token; the panel asks for a code again
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'VST Folders Scan').click());
  await until(async () => !!(await page.$('.native-host-header button[title^="Forget the pairing"]')));
  await page.click('.native-host-header button[title^="Forget the pairing"]');
  check('Unpairing forgets the token and asks for a code again', await until(async () => { const c = await core(); return !c.connected && c.needsPairing; }), JSON.stringify(await core()));
  check('The token is gone from localStorage', (await page.evaluate(() => localStorage.getItem('noprod.ghostdaw.token'))) === null);

  // 7b. A stale token (GhostDAW's was rotated, say) asks for a code again
  await page.evaluate(() => localStorage.setItem('noprod.ghostdaw.token', 'f'.repeat(64)));
  await page.reload({ waitUntil: 'networkidle0', timeout: 120000 });
  await page.mouse.click(5, 5);
  check('A stale token asks for a code again', await until(async () => { const c = await core(); return !c.connected && c.needsPairing; }), JSON.stringify(await core()));
  check('The stale token is dropped', (await page.evaluate(() => localStorage.getItem('noprod.ghostdaw.token'))) === null);

  // 8. As other clients see it: the hosted app's origin pairs with the code;
  // a lookalike origin and a wrong token get no handshake; a paired client's
  // LOAD_PLUGIN by path is refused
  const control = 'ws://localhost:8082';
  const hosted = await probe(control, 'https://agentchieflou.github.io', { type: 'PAIR', code: ctx.ghostdaw.pairingCode });
  check('The hosted app\'s origin gets a handshake and pairs with the code', hosted.opened && hosted.replies[0]?.type === 'PAIRED' && hosted.replies[0].token === token, JSON.stringify(hosted));
  const lookalike = await probe(control, 'https://agentchieflou.github.io.evil.example', { type: 'PAIR', code: ctx.ghostdaw.pairingCode });
  check('A lookalike origin is refused at the handshake', !lookalike.opened && lookalike.status === 403, JSON.stringify(lookalike));
  const wrongToken = await probe(`ws://localhost:8083/?token=${'f'.repeat(64)}`, null, { type: 'OPEN', streamId: 'x', sampleRate: 48000, maxBlockSize: 256 });
  check('A wrong token is refused at the stream server\'s handshake', !wrongToken.opened && wrongToken.status === 403, JSON.stringify(wrongToken));
  const staleToken = await probe(`${control}/?token=${'f'.repeat(64)}`, null, { type: 'GET_AUDIO_CORE_STATE' });
  check('A wrong token on the control server is an unpaired connection: it may only PAIR', staleToken.opened && staleToken.replies[0]?.type === 'AUDIO_CORE_ERROR' && /not paired/.test(staleToken.replies[0].message), JSON.stringify(staleToken));
  const unpaired = await probe(control, null, { type: 'GET_AUDIO_CORE_STATE' });
  check('A tokenless connection may only PAIR', unpaired.opened && unpaired.replies[0]?.type === 'AUDIO_CORE_ERROR' && /not paired/.test(unpaired.replies[0].message), JSON.stringify(unpaired));
  const byPath = await probe(`${control}/?token=${token}`, null, { type: 'LOAD_PLUGIN', path: '/tmp/evil.so', format: 'LPI', bus: 'master' });
  check('A paired client\'s LOAD_PLUGIN by path is refused', byPath.opened && byPath.replies[0]?.type === 'AUDIO_CORE_ERROR' && /pluginId/.test(byPath.replies[0].message), JSON.stringify(byPath));
  const folders = await probe(`${control}/?token=${token}`, null, { type: 'SCAN_PLUGINS', paths: ['/tmp'] });
  check('SCAN_PLUGINS ignores the folders a client names', folders.opened && folders.replies[0]?.type === 'AUDIO_CORE_STATE' && !folders.replies[0].scanFolders.includes('/tmp'), JSON.stringify(folders.replies[0]?.scanFolders));
  const tooBig = await streamProbe(`ws://localhost:${streamPort}/?token=${token}`, [
    { type: 'OPEN', streamId: 'probe', sampleRate: 48000, maxBlockSize: 256 },
    { type: 'LOAD', pluginId: 'com.noprod.test.gain', state: 'A'.repeat(3 * 1024 * 1024) }
  ]);
  check('A stream LOAD with a state chunk past the limit is refused', tooBig.replies[0]?.type === 'STREAM_OPENED' && tooBig.replies[1]?.type === 'AUDIO_CORE_ERROR' && /state: more than/.test(tooBig.replies[1].message), JSON.stringify(tooBig).slice(0, 300));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
