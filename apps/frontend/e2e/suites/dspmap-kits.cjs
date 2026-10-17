// #102: the DSP Map with drum kits, one pad's sound per column
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const setSel = (sel, value) => page.evaluate((sel, value) => {
    const el = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, sel, value);
  const lib = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    return { id: t?.id, lib: t?.instrument?.parameters?.Library, past: st.past.length };
  });
  const heads = () => page.evaluate(() => [...document.querySelectorAll('.dsp-map-head')].map((h) => ({
    col: h.dataset.col, name: h.querySelector('.dsp-head-name').textContent, source: h.querySelector('.dsp-head-source span').textContent,
    pad: h.querySelector('.designer-pad')?.value ?? null, pads: [...(h.querySelector('.designer-pad')?.options ?? [])].map((o) => o.value) })));
  await page.mouse.click(5, 5);

  // 1. A kit on a track: its column is the selected one, with a pad picker
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Drum Kits')).click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.textContent.trim() === '808 Kit').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(600);
  const t0 = await lib();
  const h0 = (await heads())[0];
  const first = t0.lib.kit && Object.keys(t0.lib.kit.pads).map(Number).sort((a, b) => a - b).map((n) => t0.lib.kit.pads[n].sound)[0];
  check('Double-clicking "808 Kit" adds a kit track whose column has a pad picker, on the first pad',
    !!t0.lib?.kit && h0.col === `track:${t0.id}` && /Track · 808 Kit \(selected\)/.test(h0.source) && h0.pad === first && h0.pads.includes('snare-808'), JSON.stringify(h0));
  const tcol = h0.col;
  const labels = await page.evaluate((c) => [...document.querySelector(`.dsp-map-head[data-col="${c}"] .designer-pad`).options].find((o) => o.value === 'snare-808').textContent, tcol);
  check('The pads are labeled with their GM drum names', /Acoustic Snare/.test(labels), labels);

  // 2. The snare: its column shows its recipe; the filter block switches off in the store
  await setSel(`.dsp-map-head[data-col="${tcol}"] .designer-pad`, 'snare-808');
  await ctx.sleep(200);
  const before = await lib();
  const filter = await page.evaluate((c) => {
    const b = document.querySelector(`.dsp-map-cell[data-col="${c}"] .dsp-block[data-id^="filter:"]`);
    return b ? { id: b.dataset.id, layer: Number(b.dataset.layer) } : null;
  }, tcol);
  check('The snare column shows the snare\'s blocks, including a filter', !!filter && (await heads())[0].name === before.lib.sounds['snare-808'].name, JSON.stringify(filter));
  await page.click(`.dsp-map-cell[data-col="${tcol}"] .dsp-block[data-id="${filter.id}"][data-layer="${filter.layer}"] .dsp-power`);
  await ctx.sleep(200);
  const after = await lib();
  const bypass = after.lib.sounds['snare-808'].layers[filter.layer].bypass;
  check('Switching the filter off bypasses it in lib.sounds[\'snare-808\'].layers[i].bypass', JSON.stringify(bypass) === JSON.stringify([filter.id]), JSON.stringify(bypass));
  const others = Object.keys(before.lib.sounds).filter((id) => id !== 'snare-808');
  check('The other pads are unchanged', others.length > 3 && others.every((id) => JSON.stringify(after.lib.sounds[id]) === JSON.stringify(before.lib.sounds[id])), `${others.length} pads`);
  check('The pad choice is kept after the edit', (await heads())[0].pad === 'snare-808');

  // 3. Undo reverts
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(200);
  const undone = await lib();
  check('Undo reverts the edit', JSON.stringify(undone.lib.sounds['snare-808']) === JSON.stringify(before.lib.sounds['snare-808']) && undone.past === before.past);

  // 4. A library kit from the picker, on its snare: shared blocks with the 808 snare
  await setSel('.dsp-map-picker', 'kit:kit-acoustic');
  await ctx.sleep(300);
  const h1 = await heads();
  const acoustic = h1.find((h) => h.name !== h1[0].name && h.pads.length);
  check('The picker adds the Acoustic kit as a scratch column with a pad picker', h1.length === 6 && acoustic?.source === 'Library · scratch copy' && acoustic.pads.includes('snare-acoustic'), JSON.stringify(h1.map((h) => h.source)));
  await setSel(`.dsp-map-head[data-col="${acoustic.col}"] .designer-pad`, 'snare-acoustic');
  await ctx.sleep(300);
  const shared = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.dsp-shared')].map((e) => [e.dataset.kind, e.querySelector('.dsp-shared-count').textContent])));
  const names = (await heads()).map((h) => h.name);
  check('The two snares share blocks (at least noise and envelope)', shared.noise === '×2' && parseInt(shared.env.slice(1)) >= 2 && names.some((n) => /Acoustic Snare/i.test(n)), JSON.stringify({ shared, names }));
  await ctx.shot('dspmap_kits');

  // 5. Edits to a scratch kit stay in the scratch copy
  const scratchBefore = await page.evaluate(async (c) => JSON.stringify((await import('/src/components/dspMapState.ts')).savedColumns().find((x) => x.key === c).sounds['snare-acoustic']), acoustic.col);
  await page.click(`.dsp-map-cell[data-col="${acoustic.col}"] .dsp-block[data-kind="noise"] .dsp-power`);
  await ctx.sleep(200);
  const scratchAfter = await page.evaluate(async (c) => JSON.stringify((await import('/src/components/dspMapState.ts')).savedColumns().find((x) => x.key === c).sounds['snare-acoustic']), acoustic.col);
  const trackLib = await lib();
  check('A scratch kit column edits its own copy, not the library', scratchBefore !== scratchAfter && /bypass/.test(scratchAfter), '');
  check('…and leaves the track alone', JSON.stringify(trackLib.lib.sounds) === JSON.stringify(before.lib.sounds));

  // 6. A kit column plays through its pad
  const peak = await page.evaluate(async (c) => {
    document.querySelector(`.dsp-map-head[data-col="${c}"] .designer-play`).click();
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let p = 0;
    const end = performance.now() + 1500;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) p = Math.max(p, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    return p;
  }, tcol);
  check('A kit column plays its pad\'s sound', peak > 0.02, `peak ${peak.toFixed(3)}`);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
