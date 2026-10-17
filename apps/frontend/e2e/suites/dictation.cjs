// #68, #133, #157: dictation → the provider, called from the browser with the
// user's own key (stubbed here) → code → our pattern engine → library tracks
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const KEY = 'AIzaSyTESTKEY-0123456789abcdef';
  const HOST = 'generativelanguage.googleapis.com';
  await page.mouse.click(5, 5);
  // No orchestrator in this suite: GhostDAW's relay stays off, and the spies
  // below see every request and socket the page makes from here on
  await page.evaluate(() => window.__services.set('ghostdaw', { enabled: false }));
  await ctx.sleep(1000);
  await page.evaluate((HOST) => {
    window.__fetchLog = [];
    window.__sockets = [];
    window.__answers = [];
    const Real = window.WebSocket;
    window.WebSocket = new Proxy(Real, { construct(target, args) { window.__sockets.push(String(args[0])); return new target(...args); } });
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const u = new URL(String(input?.url ?? input), location.href);
      window.__fetchLog.push({ host: u.host, path: u.pathname, method: init?.method || 'GET', key: init?.headers?.['x-goog-api-key'] ?? null, body: typeof init?.body === 'string' ? init.body : null, url: u.href });
      if (u.host !== HOST) return real(input, init);
      if (!u.pathname.endsWith(':generateContent')) return new Response('{}');
      const next = window.__answers.shift();
      if (typeof next === 'number') return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: next });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: next ?? '' }] } }] }));
    };
  }, HOST);
  const requests = () => page.evaluate(() => window.__fetchLog.filter((r) => r.host === 'generativelanguage.googleapis.com'));
  const setInput = (placeholder, text) => page.evaluate((placeholder, text) => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes(placeholder));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, placeholder, text);
  const click = (text) => page.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text).click(), text);
  const boxUi = () => page.evaluate(() => ({
    input: !![...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('Describe')),
    line: !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Add your API key to dictate')),
    tab: [...document.querySelectorAll('.detail-tab')].some((b) => b.textContent.trim() === 'AI Dictation')
  }));

  // Without a key: one line, no request, no connection; nothing else changes
  let ui = await boxUi();
  check('With no key the box is the one line "Add your API key to dictate", with no input and no tab', ui.line && !ui.input && !ui.tab, JSON.stringify(ui));
  await ctx.sleep(1500);
  check('With no key nothing connects: no request to the provider, no WebSocket', (await requests()).length === 0 && (await page.evaluate(() => window.__sockets.length)) === 0);
  await click('Add your API key to dictate');
  await ctx.sleep(300);
  check('The line opens the settings, which say the key stays here and the billing is the user\'s',
    await page.evaluate(() => { const t = document.querySelector('[data-dictation-settings]')?.textContent || ''; return /stays in this browser/.test(t) && /billed to your own account/.test(t) && !!document.querySelector('[data-dictation-settings] a[href^="https://aistudio.google.com"]'); }));
  await ctx.shot('dictation-settings');

  // The test button makes one cheap call, with the key in a header
  await setInput('Paste your key', KEY);
  await click('Test key');
  await ctx.sleep(500);
  const tested = await requests();
  check('Test key makes one call to the provider, a GET that generates nothing, with the key in a header',
    tested.length === 1 && tested[0].method === 'GET' && !tested[0].path.includes('generateContent') && tested[0].key === KEY && !tested[0].url.includes(KEY), JSON.stringify(tested));
  check('It says the key works', await page.evaluate(() => /The key works/.test(document.querySelector('[data-dictation-settings] [role=status]').textContent)));
  await click('Save');
  await ctx.sleep(300);
  await page.evaluate(() => document.querySelector('[data-dictation-settings] button[title=Close]').click());
  ui = await boxUi();
  check('With the key saved the box takes a description and the tab appears', ui.input && !ui.line && ui.tab, JSON.stringify(ui));

  // (one line: the dictation box is a single-line input)
  const code = `setcpm(124/4); stack(
  s("bd*4, ~ cp ~ cp, hh*8").bank("RolandTR909"),
  note("c2 ~ c2 eb2 ~ g1 ~ bb1").s("bass"),
  note("<[c4,eb4,g4]>").s("epiano").gain(0.6),
  s("vinylcrackle")
)`;
  const before = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  // Dictate through the UI: the stubbed provider answers with the code
  await page.evaluate((code) => { window.__answers.push(code); }, code);
  await setInput('Describe', 'a house beat with a bass line');
  await click('Dictate');
  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await page.evaluate(() => {
      const st = window.__dawStore.getState();
      return { count: st.tracks.length, bpm: st.bpm };
    });
    if (state.count > 0 && state.count >= 3 + 0) break;
    await ctx.sleep(250);
  }
  await ctx.sleep(500);
  const made = await page.evaluate((before) => {
    const st = window.__dawStore.getState();
    const added = st.tracks.slice(before);
    return {
      bpm: st.bpm,
      tracks: added.map((t) => {
        const region = st.regions.find((r) => r.trackId === t.id);
        const lib = t.instrument.parameters.Library;
        return {
          name: t.name, kit: lib.kit?.id, sound: lib.sound?.id,
          clip: region && { file: region.file, loop: region.loopEnabled, loopEnd: +region.loopEnd.toFixed(3), duration: +region.duration.toFixed(3),
            notes: region.notes.map((n) => n.pitch), starts: region.notes.map((n) => +n.start.toFixed(3)) }
        };
      }),
      result: document.querySelector('.dictation-result')?.textContent
    };
  }, before);
  console.log(JSON.stringify(made));
  const kit = made.tracks.find((t) => t.kit);
  const bass = made.tracks.find((t) => t.sound === 'bass-pluck');
  const keys = made.tracks.find((t) => t.sound === 'piano-electric');
  check('The pattern\'s tempo becomes the project\'s', made.bpm === 124, `${made.bpm} BPM`);
  check('The drums become a 909-style library kit track', kit?.kit === 'kit-electronic' && kit.clip.notes.filter((p) => p === 36).length === 4
    && kit.clip.notes.filter((p) => p === 39).length === 2 && kit.clip.notes.filter((p) => p === 42).length === 8, JSON.stringify(kit?.clip?.notes));
  const bar = 240 / 124;
  check('Clips loop one bar, as long as four', !!kit && Math.abs(kit.clip.loopEnd - bar) < 0.01 && Math.abs(kit.clip.duration - 4 * bar) < 0.01 && kit.clip.loop === true, `bar ${bar.toFixed(3)} s`);
  check('The bass line plays the bass sound at its notes', bass && JSON.stringify(bass.clip.notes) === JSON.stringify([36, 36, 39, 31, 34]), JSON.stringify(bass?.clip?.notes));
  check('The chord plays the electric piano', keys && JSON.stringify([...keys.clip.notes].sort()) === JSON.stringify([60, 63, 67]), JSON.stringify(keys?.clip?.notes));
  check('Unknown sounds are reported, not guessed', /vinylcrackle/.test(made.result || ''), made.result);

  // It plays: arrangement playback at the master
  const peak = await page.evaluate(async () => {
    window.__transport.setPosition(0);
    window.__dawStore.getState().togglePlayback();
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let p = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) p = Math.max(p, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    window.__dawStore.getState().togglePlayback();
    return p;
  });
  check('The dictated tracks play', peak > 0.05, `peak ${peak.toFixed(3)}`);

  const generates = async () => (await requests()).filter((r) => r.path.endsWith(':generateContent'));
  check('The first dictation was one request, with the key and the description', await (async () => {
    const g = await generates();
    return g.length === 1 && g[0].method === 'POST' && g[0].key === KEY && /house beat/.test(g[0].body) && !g[0].body.includes(KEY);
  })());

  // A second dictation without a tempo doesn't change it
  await page.evaluate(() => { window.__answers.push('```\nnote("c3 e3 g3 c4")\n```'); });
  await setInput('Describe', 'a little arpeggio');
  await click('Dictate');
  await ctx.sleep(1500);
  const second = await page.evaluate(() => { const st = window.__dawStore.getState(); const t = st.tracks.at(-1); return { bpm: st.bpm, sound: t.instrument.parameters.Library?.sound?.id, name: t.name }; });
  check('A melody with no sound name plays the triangle, tempo unchanged (and a fenced answer is unwrapped)', second.sound === 'lead-triangle' && second.bpm === 124, JSON.stringify(second));

  // Code that doesn't parse: one more request, with the error in it
  let tracksBefore = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  let sent = (await generates()).length;
  await page.evaluate(() => { window.__answers.push('s("bd").foo()', 'note("c2 g2")'); });
  await setInput('Describe', 'a bass');
  await click('Dictate');
  await ctx.sleep(1500);
  let g = await generates();
  const retry = g.length === sent + 2 ? JSON.parse(g[g.length - 1].body) : null;
  check('A parse error leads to one retry, with the error and the first answer in the prompt',
    !!retry && retry.contents.length === 3 && /unknown method "\.foo"/.test(retry.contents[2].parts[0].text) && retry.contents[1].parts[0].text === 's("bd").foo()', retry ? JSON.stringify(retry.contents.map((c) => c.role)) : `${g.length - sent} requests`);
  check('The retry\'s code becomes the track', (await page.evaluate(() => window.__dawStore.getState().tracks.length)) === tracksBefore + 1);

  // Bad code twice is an error shown to the user, not a crash
  tracksBefore = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  sent = g.length;
  await page.evaluate(() => { window.__answers.push('s("bd").foo()', 's("bd").foo()'); });
  await setInput('Describe', 'something broken');
  await click('Dictate');
  await ctx.sleep(1500);
  g = await generates();
  const after = await page.evaluate(() => ({ tracks: window.__dawStore.getState().tracks.length, text: document.querySelector('.vst-paths-view')?.textContent || '' }));
  check('Bad code twice is reported, makes no tracks, and asks no more than twice', after.tracks === tracksBefore && g.length === sent + 2 && /unknown method "\.foo"/.test(after.text), after.text.slice(-120));

  // Errors in words
  const errorText = async (answer, prompt) => {
    await page.evaluate((a) => { window.__answers.push(a); }, answer);
    await setInput('Describe', prompt);
    await click('Dictate');
    await ctx.sleep(600);
    return page.evaluate(() => document.querySelector('.vst-paths-view')?.textContent || '');
  };
  check('A rejected key reads as "did not accept this key"', /did not accept this key/.test(await errorText(403, 'x')));
  check('A quota error reads as quota', /run out of quota/.test(await errorText(429, 'x')));
  await page.evaluate(() => { window.__answers.push(''); });
  await setInput('Describe', 'x');
  await click('Dictate');
  await ctx.sleep(600);
  check('An empty answer reads as declined', /declined to answer/.test(await page.evaluate(() => document.querySelector('.vst-paths-view')?.textContent || '')));

  // Limits: a long description is refused without a request
  sent = (await requests()).length;
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('Describe'));
    return input.maxLength;
  }).then((max) => check('The box caps the description', max === 500, `maxLength ${max}`));

  // One request at a time, and cancellable
  await page.evaluate(() => {
    window.__release = null;
    const stub = window.fetch;
    window.fetch = (input, init) => {
      const u = String(input?.url ?? input);
      if (!u.includes(':generateContent')) return stub(input, init);
      return new Promise((resolve, reject) => {
        window.__fetchLog.push({ host: new URL(u).host, path: new URL(u).pathname, method: 'POST', key: init.headers['x-goog-api-key'], body: init.body, url: u });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    window.__stub = stub;
  });
  sent = (await generates()).length;
  await setInput('Describe', 'slow one');
  await click('Dictate');
  await ctx.sleep(300);
  const hung = await page.evaluate(() => ({ cancel: !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel'), dictate: !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dictate') }));
  await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find((x) => (x.placeholder || '').includes('Describe')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await ctx.sleep(300);
  check('While waiting there is Cancel and no second Dictate, and Enter makes no second request', hung.cancel && !hung.dictate && (await generates()).length === sent + 1, JSON.stringify(hung));
  await click('Cancel');
  await ctx.sleep(300);
  check('Cancel stops the wait and the box is ready again', await page.evaluate(() => !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dictate') && !/Generating/.test(document.body.textContent)));
  await page.evaluate(() => { window.fetch = window.__stub; });

  // The key stays in this browser: not in the project, an autosave, an
  // export or localStorage (but its own entry), and no other host is called
  const leaks = await page.evaluate(async (KEY) => {
    const bytes = new TextEncoder().encode(KEY);
    const hasBytes = (buf) => {
      const a = new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
      outer: for (let i = 0; i + bytes.length <= a.length; i++) { for (let j = 0; j < bytes.length; j++) if (a[i + j] !== bytes[j]) continue outer; return true; }
      return false;
    };
    const seen = new Set();
    const walk = async (v) => {
      if (v == null || typeof v === 'number' || typeof v === 'boolean') return false;
      if (typeof v === 'string') return v.includes(KEY);
      if (v instanceof Blob) return hasBytes(new Uint8Array(await v.arrayBuffer()));
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return hasBytes(v);
      if (typeof v !== 'object' || seen.has(v)) return false;
      seen.add(v);
      for (const x of v instanceof Map ? [...v.keys(), ...v.values()] : Object.values(v)) if (await walk(x)) return true;
      return false;
    };
    const out = {};
    const state = window.__dawStore.getState();
    out.store = JSON.stringify(state, (k, v) => (typeof v === 'function' || v instanceof AudioBuffer ? undefined : v)).includes(KEY);
    const { snapshotProject, serializeProject } = await import('/src/project/projectFile.ts');
    out.snapshot = snapshotProject(state).json.includes(KEY);
    out.export = await walk(await serializeProject(state));
    const { writeAutosave } = await import('/src/project/autosave.ts');
    await writeAutosave(state);
    out.autosaveDbs = [];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const store of db.objectStoreNames) {
        const rows = await new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        out.autosaveDbs.push(`${name}/${store}:${rows.length}`);
        if (await walk(rows)) out[`idb ${name}/${store}`] = true;
      }
      db.close();
    }
    out.localStorage = Object.keys(localStorage).filter((k) => (localStorage.getItem(k) || '').includes(KEY) || k.includes(KEY));
    out.sessionStorage = Object.keys(sessionStorage).filter((k) => (sessionStorage.getItem(k) || '').includes(KEY));
    out.hosts = [...new Set(window.__fetchLog.map((r) => r.host))];
    out.keyedElsewhere = window.__fetchLog.filter((r) => r.host !== 'generativelanguage.googleapis.com' && (r.key || (r.body || '').includes(KEY) || r.url.includes(KEY))).length;
    out.sockets = window.__sockets;
    return out;
  }, KEY);
  console.log(JSON.stringify(leaks));
  check('The key is in no saved project, export or autosave (the store, the project JSON, the file, every IndexedDB store)',
    !leaks.store && !leaks.snapshot && !leaks.export && !Object.keys(leaks).some((k) => k.startsWith('idb ')) && leaks.autosaveDbs.length > 0, JSON.stringify(leaks.autosaveDbs));
  check('The key is in localStorage only under its own entry', JSON.stringify(leaks.localStorage) === JSON.stringify(['noprod.dictation.gemini-key']) && leaks.sessionStorage.length === 0, JSON.stringify(leaks.localStorage));
  check('Requests go to this page\'s host and the provider only, the key goes to the provider only, and no WebSocket opens',
    leaks.hosts.every((h) => h === HOST || h === new URL(page.url()).host) && leaks.keyedElsewhere === 0 && leaks.sockets.length === 0, JSON.stringify({ hosts: leaks.hosts, sockets: leaks.sockets }));

  // Forget key: gone from storage, back to the one line, and nothing is requested
  await click('Key');
  await ctx.sleep(200);
  await click('Forget key');
  await ctx.sleep(300);
  await page.evaluate(() => document.querySelector('[data-dictation-settings] button[title=Close]').click());
  ui = await boxUi();
  check('Forget key removes it from storage and returns the box to the one line',
    ui.line && !ui.input && !ui.tab && (await page.evaluate(() => localStorage.getItem('noprod.dictation.gemini-key'))) === null, JSON.stringify(ui));
  sent = (await requests()).length;
  await ctx.sleep(500);
  check('After forgetting, nothing more is requested', (await requests()).length === sent);

  await ctx.shot('dictation');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
