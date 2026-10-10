// #79: modeled instruments in the Browser, on a track, playing
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Strings')).click());
  await ctx.sleep(150);
  const listed = await page.evaluate(() => [...document.querySelectorAll('.browser-item')].map((e) => ({ label: e.querySelector('.browser-item-label')?.textContent, title: e.title }))
    .filter((x) => ['Violin', 'Viola', 'Cello', 'Double Bass'].includes(x.label)));
  check('The bowed strings are in the Browser, tagged modeled', listed.length === 4 && listed.every((x) => /modeled/.test(x.title)), JSON.stringify(listed));

  const before = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Violin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(800);
  const track = await page.evaluate(() => { const st = window.__dawStore.getState(); const t = st.tracks.at(-1); return { count: st.tracks.length, sound: t.instrument.parameters.Library?.sound?.id, name: t.name }; });
  check('Double-clicking the violin adds a MIDI track playing it', track.count === before + 1 && track.sound === 'violin', JSON.stringify(track));

  const played = await page.evaluate(async () => {
    const { startVoice } = await import('/src/audio/synth.ts');
    const { analysis, findSound } = await import(window.__fs + '/packages/sound/src/index.ts');
    const params = { Kit: 'library', Gain: 1, Tune: 0, Library: { sound: findSound('violin') } };
    const off = new OfflineAudioContext(2, 3 * 44100, 44100);
    const t0 = performance.now();
    const v = startVoice(off, off.destination, params, 69, 0, 1);
    v.release(1.2);
    const d = (await off.startRendering()).getChannelData(0);
    return { ms: Math.round(performance.now() - t0), hz: analysis.estimatePitch(d, 44100, Math.round(0.6 * 44100), 8192, 300, 600),
      held: analysis.levelAt(d, 44100, 0.8), after: analysis.levelAt(d, 44100, 2.9, 0.05) };
  });
  check('The violin plays the note held (A4), then stops', Math.abs(1200 * Math.log2(played.hz / 440)) < 10 && played.held > 0.05 && played.after < played.held * 0.01, JSON.stringify(played));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
