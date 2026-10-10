// #66: the Sound Designer
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = "") => { const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`; results.push(line); console.log(line); };
  const S = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    return { name: t?.instrument?.name, lib: t?.instrument?.parameters?.Library, past: st.past.length };
  });
  await page.mouse.click(5, 5);

  // Capture downloads: anchors clicked with a blob URL
  await page.evaluate(() => {
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () {
      const href = this.href, name = this.download;
      window.__downloads.push(fetch(href).then((r) => r.arrayBuffer()).then((b) => ({ name, bytes: [...new Uint8Array(b.slice(0, 64))], size: b.byteLength, all: b })));
    };
  });

  // 1. Pencil on Grand Piano: loads it on a new MIDI track and opens the designer
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Keys')).click());
  await ctx.sleep(100);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Grand Piano');
    item.querySelector('button[title="Edit in the Sound Designer"]').click();
  });
  await ctx.sleep(1500);
  const opened = await page.evaluate(() => ({
    designer: !!document.querySelector('.sound-designer'),
    cards: document.querySelectorAll('.designer-layer').length,
    name: document.querySelector('.designer-name')?.value,
    bars: document.querySelector('.partial-editor').querySelectorAll('.partial-bar').length
  }));
  const s0 = await S();
  check('Pencil opens the sound in the designer on a MIDI track', opened.designer && opened.name === 'Grand Piano' && s0.lib?.sound?.id === 'piano-grand', JSON.stringify(opened));
  check('One card per layer; partials drawn as bars', opened.cards === 3 && opened.bars === s0.lib.sound.layers[0].partials.length, `${opened.cards} cards, ${opened.bars} bars`);

  // 2. The spectrogram shows the sound
  const lit = await page.evaluate(() => {
    const c = document.querySelector('.spectrogram');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height - 22).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 150) bright++;
    return bright / (d.length / 4);
  });
  check('The spectrogram shows the sound', lit > 0.02, `${(lit * 100).toFixed(1)}% bright`);

  // 3. A slider edits the recipe on the track (release of layer 1)
  const before = (await S()).lib.sound.layers[0].env.release;
  await page.evaluate(() => {
    const card = document.querySelectorAll('.designer-layer')[0];
    const row = [...card.querySelectorAll('.param-slider-row')].find((r) => r.querySelector('.param-name')?.textContent === 'Release');
    const input = row.querySelector('input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '900');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await ctx.sleep(200);
  const after = (await S()).lib.sound.layers[0].env.release;
  check('A slider edits the track\'s sound', after !== before && after > 2, `release ${before} → ${after}`);

  // 4. Dragging a partial bar raises its level
  const dragged = await page.evaluate(async () => {
    const bar = document.querySelectorAll('.partial-editor')[0].querySelectorAll('.partial-bar')[8];
    const r = bar.getBoundingClientRect();
    const st0 = window.__dawStore.getState();
    const level0 = st0.tracks.find((t) => t.id === st0.selectedTrackId).instrument.parameters.Library.sound.layers[0].partials[8].level;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + 2, clientY: r.y, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.x + 2, clientY: r.y - 30, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await new Promise((res) => setTimeout(res, 100));
    const st = window.__dawStore.getState();
    return { level0, level1: st.tracks.find((t) => t.id === st.selectedTrackId).instrument.parameters.Library.sound.layers[0].partials[8].level };
  });
  check('Dragging a partial up raises its level', dragged.level1 > dragged.level0 * 1.5, JSON.stringify(dragged));

  // 5. Add, mute and remove layers
  await page.evaluate(() => [...document.querySelectorAll('.designer-add .designer-button')].find((b) => b.textContent.includes('Noise')).click());
  await ctx.sleep(100);
  const added = (await S()).lib.sound.layers.length;
  await page.evaluate(() => { const cards = document.querySelectorAll('.designer-layer'); cards[cards.length - 1].querySelector('button[title="Mute layer"]').click(); });
  await ctx.sleep(100);
  const muted = (await S()).lib.sound.layers.at(-1).mute;
  await page.evaluate(() => { const cards = document.querySelectorAll('.designer-layer'); cards[cards.length - 1].querySelector('button[title="Remove layer"]').click(); });
  await ctx.sleep(100);
  const removed = (await S()).lib.sound.layers.length;
  check('Layers add, mute and remove', added === 4 && muted === true && removed === 3, `${added} → muted ${muted} → ${removed}`);

  // 6. Renaming renames the instrument too
  await page.evaluate(() => {
    const input = document.querySelector('.designer-name');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus(); setter.call(input, 'My Piano'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur();
  });
  await ctx.sleep(150);
  const renamed = await S();
  check('Renaming renames the sound and the instrument', renamed.name === 'My Piano' && renamed.lib.sound.name === 'My Piano', renamed.name);

  // 7. Undo: the rename, then the burst of quick edits before it (coalesced into one step)
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(150);
  const undoRename = await S();
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(150);
  const undoEdits = await S();
  check('Undo walks designer edits back', undoRename.lib.sound.name === 'Grand Piano' && undoRename.lib.sound.layers.length === 3
    && undoEdits.lib?.sound?.layers?.[0]?.env?.release === before, `${undoRename.lib.sound.name}, release ${undoEdits.lib?.sound?.layers?.[0]?.env?.release}`);
  await page.evaluate(() => { const st = window.__dawStore.getState(); st.redo(); st.redo(); });
  await ctx.sleep(150);

  // 5b. A physical model layer (#77): pick its exciter, add a radiator
  await page.evaluate(() => [...document.querySelectorAll('.designer-add .designer-button')].find((b) => b.textContent.includes('Model')).click());
  await ctx.sleep(150);
  const modelled = await page.evaluate(async () => {
    const sel = (card, label) => [...card.querySelectorAll('.param-slider-row')].find((r) => r.querySelector('.param-name')?.textContent === label)?.querySelector('select');
    const setSel = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const card = () => [...document.querySelectorAll('.designer-layer')].at(-1);
    const sections = [...card().querySelectorAll('summary')].map((s) => s.textContent);
    setSel(sel(card(), 'Kind'), 'bow');
    await new Promise((r) => setTimeout(r, 150));
    const params = [...card().querySelectorAll('.param-name')].map((n) => n.textContent);
    setSel(card().querySelector('select[aria-label="Add a radiator"]'), 'bell');
    await new Promise((r) => setTimeout(r, 150));
    const st = window.__dawStore.getState();
    const layer = st.tracks.find((t) => t.id === st.selectedTrackId).instrument.parameters.Library.sound.layers.at(-1);
    return { sections, params, layer };
  });
  check('A Model layer edits its exciter, resonator and radiators', modelled.layer.type === 'model' && modelled.layer.exciter.kind === 'bow'
    && modelled.layer.radiators.map((r) => r.kind).join() === 'body,bell' && ['Exciter', 'Resonator'].every((s) => modelled.sections.some((x) => x.startsWith(s)))
    && modelled.params.includes('Pressure'), JSON.stringify(modelled));
  await ctx.sleep(1500);
  await page.evaluate(() => { const cards = document.querySelectorAll('.designer-layer'); cards[cards.length - 1].querySelector('button[title="Remove layer"]').click(); });
  await ctx.sleep(150);

  // 8. Save → My Sounds, same samples under a new id, in the Browser
  const savedOld = (await S()).lib.sound;
  await page.evaluate(() => [...document.querySelectorAll('.designer-button')].find((b) => b.textContent.includes('Save')).click());
  await ctx.sleep(500);
  const saved = await page.evaluate(async (old) => {
    const st = window.__dawStore.getState();
    const now = st.tracks.find((t) => t.id === st.selectedTrackId).instrument.parameters.Library.sound;
    const { render } = await import(window.__fs + '/packages/sound/src/index.ts');
    const a = render(old, { note: 60, gate: 0.3 }).left, b = render(now, { note: 60, gate: 0.3 }).left;
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) same = a[i] === b[i];
    const { getUserSounds } = await import('/src/audio/userSounds.ts');
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('noprod-sounds', 1);
      req.onsuccess = () => { const g = req.result.transaction('sounds').objectStore('sounds').getAll(); g.onsuccess = () => resolve(g.result.map((x) => x.id)); };
    });
    const groups = [...document.querySelectorAll('.browser-folder')].map((e) => e.textContent.trim());
    return { id: now.id, same, mine: getUserSounds().map((x) => x.id), db, myGroup: groups.find((g) => g.startsWith('My Sounds')) };
  }, savedOld);
  check('Save keeps the sound in My Sounds (same samples, new id)', saved.id.startsWith('my-') && saved.same && saved.mine.includes(saved.id) && saved.db.includes(saved.id) && !!saved.myGroup, JSON.stringify({ ...saved, mine: saved.mine.length }));

  // 9. Export WAV downloads a 24-bit WAV
  await page.evaluate(() => [...document.querySelectorAll('.designer-button')].find((b) => b.textContent.includes('WAV')).click());
  await ctx.sleep(1500);
  const wav = await page.evaluate(async () => { const d = await window.__downloads.at(-1); return { name: d.name, head: String.fromCharCode(...d.bytes.slice(0, 4)) + String.fromCharCode(...d.bytes.slice(8, 12)), bits: d.bytes[34], size: d.size }; });
  check('WAV export downloads a 24-bit WAV', wav.head === 'RIFFWAVE' && wav.bits === 24 && wav.name === 'My Piano.wav' && wav.size > 100000, JSON.stringify(wav));

  // 10. A group downloads as a zip (My Sounds: one WAV)
  await page.evaluate(() => {
    const group = [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('My Sounds'));
    group.querySelector('button[title^="Download"]').click();
  });
  await ctx.sleep(2000);
  const zipped = await page.evaluate(async () => {
    const d = await window.__downloads.at(-1);
    const v = new DataView(d.all);
    return { name: d.name, sig: v.getUint32(0, true).toString(16), entries: v.getUint16(d.size - 22 + 10, true) };
  });
  check('A Browser group downloads as a zip of WAVs', zipped.name === 'My Sounds.zip' && zipped.sig === '4034b50' && zipped.entries === 1, JSON.stringify(zipped));

  // 11. A kit: the designer edits one of its sounds
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Drum Kits')).click());
  await ctx.sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.textContent.trim() === '808 Kit').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(800);
  const kit = await page.evaluate(async () => {
    const pad = document.querySelector('.designer-pad');
    const options = pad ? pad.options.length : 0;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(pad, 'snare-808'); pad.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const name = document.querySelector('.designer-name').value;
    const card = document.querySelectorAll('.designer-layer')[0];
    const section = [...card.querySelectorAll('details')].find((d) => d.querySelector('summary').textContent === 'Level & tuning');
    const row = [...section.querySelectorAll('.param-slider-row')].find((r) => r.querySelector('.param-name')?.textContent === 'Level');
    const input = row.querySelector('input[type=range]');
    const s2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s2.call(input, '200'); input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const st = window.__dawStore.getState();
    const lib = st.tracks.find((t) => t.id === st.selectedTrackId).instrument.parameters.Library;
    return { options, name, level: lib.sounds['snare-808'].layers[0].level, kick: lib.sounds['kick-808'].layers[0].level };
  });
  check('A kit\'s sounds are edited one at a time', kit.options > 20 && kit.name === '808 Snare' && kit.level === 0.4 && kit.kick === undefined, JSON.stringify(kit));

  await ctx.sleep(800);
  await ctx.shot('designer');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));

  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
