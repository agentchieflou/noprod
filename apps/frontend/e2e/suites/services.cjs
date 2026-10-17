// #139: local services are opt-in; native plug-ins in a project ask first
const { spawn } = require('child_process');
const { join } = require('path');

module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  let orchestrator = null;
  const startOrchestrator = async () => {
    orchestrator = spawn(process.execPath, [join(__dirname, '..', 'fake-orchestrator.mjs')], { stdio: 'ignore' });
    await ctx.sleep(1500);
  };
  const stopOrchestrator = async () => { orchestrator?.kill(); orchestrator = null; await ctx.sleep(500); };
  const waitFor = async (fn, arg, ms = 20000) => {
    for (let t = 0; t < ms; t += 250) { if (await page.evaluate(fn, arg)) return true; await ctx.sleep(250); }
    return false;
  };
  const ui = () => page.evaluate(() => ({
    box: !![...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('Describe')),
    tabs: [...document.querySelectorAll('.detail-tab')].map((b) => b.textContent.trim()),
    panel: !!document.querySelector('.native-host')
  }));

  try {
    await startOrchestrator();

    // Production builds start with nothing on
    const prod = await page.evaluate(() => window.__services.defaults(false));
    check('Production defaults: every service off', !prod.dictation.enabled && !prod.ghostdaw.enabled);

    // Off: no connection, no UI for it
    await page.evaluate(() => {
      window.__sockets = [];
      const Real = window.WebSocket;
      window.WebSocket = new Proxy(Real, { construct(target, args) { window.__sockets.push(String(args[0])); return new target(...args); } });
      window.__services.set('dictation', { enabled: false });
      window.__services.set('ghostdaw', { enabled: false });
    });
    await ctx.sleep(3000);
    check('With services off, no WebSocket is opened', (await page.evaluate(() => window.__sockets.length)) === 0, await page.evaluate(() => window.__sockets.join(',')));
    let state = await ui();
    check('With services off, the dictation box and the dictation tab are hidden', !state.box && !state.tabs.includes('AI Dictation'), JSON.stringify(state.tabs));
    check('With services off, the Audio Core tab and panel are hidden', !state.tabs.includes('VST Folders Scan') && !state.panel);
    check('Default project has no placeholder devices', await page.evaluate(() => {
      const st = window.__dawStore.getState();
      return st.tracks.every((t) => (t.plugins || []).length === 0) && st.vstScanPaths.length === 0;
    }));

    // The dialog: one way to turn a service on
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Services').click());
    await waitFor(() => !!document.querySelector('.services-dialog'));
    await ctx.shot('services-off');
    check('The Services dialog lists GhostDAW and AI dictation, both off',
      await page.evaluate(() => [...document.querySelectorAll('.service-row')].map((r) => `${r.dataset.service}:${r.querySelector('[data-status]').dataset.status}`).join()) === 'ghostdaw:off,dictation:off');

    // Turning dictation on connects, and reconnects after the service restarts
    await page.evaluate(() => document.querySelector('[data-service=dictation] input[type=checkbox]').click());
    const connected = await waitFor(() => document.querySelector('[data-service=dictation] [data-status]')?.dataset.status === 'connected');
    check('Turning dictation on connects to the orchestrator', connected && (await page.evaluate(() => window.__sockets.includes('ws://localhost:8080'))));
    state = await ui();
    check('Dictation is back in the UI', state.box && state.tabs.includes('AI Dictation'));
    await stopOrchestrator();
    const trying = await waitFor(() => document.querySelector('[data-service=dictation] [data-status]')?.dataset.status === 'trying', null, 5000);
    await ctx.sleep(2500);
    await startOrchestrator();
    const again = await waitFor(() => document.querySelector('[data-service=dictation] [data-status]')?.dataset.status === 'connected', null, 30000);
    check('It shows "trying" when the orchestrator goes away, and reconnects when it returns', trying && again);
    await page.evaluate(() => window.__services.set('dictation', { enabled: false }));
    await ctx.sleep(500);
    const after = await page.evaluate(() => window.__sockets.length);
    await ctx.sleep(3000);
    check('Turning it off stops connecting', (await page.evaluate(() => window.__sockets.length)) === after);

    // A WebSocket that throws on construction (Safari: ws:// from an https page) is a failed attempt
    const thrown = await page.evaluate(async () => {
      const spy = window.WebSocket;
      const Throwing = function () { throw new DOMException('Insecure', 'SecurityError'); };
      Object.assign(Throwing, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      window.WebSocket = Throwing;
      let error = null;
      try { window.__services.set('dictation', { enabled: true }); } catch (e) { error = String(e); }
      await new Promise((r) => setTimeout(r, 1500));
      const status = document.querySelector('[data-service=dictation] [data-status]')?.dataset.status;
      window.WebSocket = spy;
      return { error, status, enabled: window.__services.get().dictation.enabled };
    });
    check('A WebSocket that throws on construction is a failed attempt, not an error', thrown.error === null && thrown.status === 'trying' && thrown.enabled, JSON.stringify(thrown));
    check('It connects once the socket can be opened', await waitFor(() => document.querySelector('[data-service=dictation] [data-status]')?.dataset.status === 'connected', null, 30000));
    await page.evaluate(() => window.__services.set('dictation', { enabled: false }));

    // GhostDAW on shows the native UI; a project's native device asks first
    await page.evaluate(() => window.__services.set('ghostdaw', { enabled: true }));
    await ctx.sleep(500);
    state = await ui();
    check('GhostDAW on shows the Audio Core tab', state.tabs.includes('VST Folders Scan'));
    const load = (name, path, id) => page.evaluate(async (name, path, id) => {
      const st = window.__dawStore.getState();
      const tracks = st.tracks.map((t, i) => i === 0 ? { ...t, plugins: [{ id, name, type: 'vst', pluginPath: path, format: 'VST3', parameters: {} }] } : t);
      st.loadProject({ tracks, regions: [] }, name);
    }, name, path, id);
    const dialog = () => page.evaluate(() => document.querySelector('.native-consent')?.textContent || null);
    const deviceState = (id) => page.evaluate(async (id) => (await import('/src/native/trackBridge.ts')).getNativeDeviceState(id) !== null, id);

    await load('Friend project', '/opt/plugins/Verb.vst3', 'dev-a');
    await waitFor(() => !!document.querySelector('.native-consent'), null, 5000);
    const text = await dialog();
    await ctx.shot('services-consent');
    check('A project with a native device asks before loading, and lists the plug-in', !!text && text.includes('/opt/plugins/Verb.vst3'), text);
    await ctx.sleep(1000);
    check('Nothing is loaded while it waits', !(await deviceState('dev-a')));
    await page.evaluate(() => [...document.querySelectorAll('.native-consent button')].find((b) => b.textContent === 'Load them').click());
    check('Agreeing loads the plug-in', await waitFor(async () => (await import('/src/native/trackBridge.ts')).getNativeDeviceState('dev-a') !== null, null, 10000) || await deviceState('dev-a'));

    await load('Other project', '/opt/plugins/Comp.vst3', 'dev-b');
    await waitFor(() => !!document.querySelector('.native-consent'), null, 5000);
    await page.evaluate(() => [...document.querySelectorAll('.native-consent button')].find((b) => b.textContent === "Don't load").click());
    await ctx.sleep(500);
    check('Declining loads nothing', !(await deviceState('dev-b')));
    await load('Friend project', '/opt/plugins/Verb.vst3', 'dev-a2');
    await load('Other project', '/opt/plugins/Comp.vst3', 'dev-b2');
    await ctx.sleep(1000);
    check('The answer is remembered for the project: it isn\'t asked again, and stays unloaded', (await dialog()) === null && !(await deviceState('dev-b2')));

    // The editor's port comes from GhostDAW only, in range
    const editors = await page.evaluate(async () => {
      const m = await import('/src/native/pluginEditor.ts');
      const msg = (port) => ({ editorId: 'e', slotId: 's', name: 'n', port, width: 10, height: 10 });
      const tries = [[msg(80), true], [msg(70000), true], [msg('5000'), true], [msg(5000), false]];
      const rejected = tries.map(([m1, from]) => { m.showPluginEditor(m1, () => {}, from); return m.getPluginEditor() === null; });
      m.showPluginEditor(msg(5000), () => {}, true);
      const ok = m.getPluginEditor();
      m.hidePluginEditor();
      return { rejected, url: ok?.url };
    });
    check('The editor port is checked: a number in range, from a connected GhostDAW', editors.rejected.every(Boolean) && editors.url === 'ws://localhost:5000', JSON.stringify(editors));
  } finally {
    await stopOrchestrator();
  }

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
