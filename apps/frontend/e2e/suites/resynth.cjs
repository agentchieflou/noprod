// #67: resynthesis in the app
const fs = require('fs');
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  // A library sound on a new MIDI track, open in the designer
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Keys')).click());
  await ctx.sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Clav').querySelector('button[title="Edit in the Sound Designer"]').click());
  await ctx.sleep(800);
  const sound = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    const r = t.instrument.parameters.Library.sound;
    return { inst: t.instrument.name, id: r.id, name: r.name, pitched: r.pitched, root: r.root, layers: r.layers.map((l) => l.type), tags: r.tags };
  });

  // 1. From audio (the file picker): a marimba at E4 becomes a pitched sound rooted at E4
  const input = await page.$('.sound-designer input[type=file]');
  await input.uploadFile(`${ctx.fixtures}/Marimba E4.wav`);
  let got = null;
  for (let i = 0; i < 40 && !(got = await sound()).tags?.includes('resynthesized'); i++) await ctx.sleep(250);
  check('From audio replaces the sound with the recording\'s resynthesis', got.tags?.includes('resynthesized') && got.inst === 'Marimba E4' && got.name === 'Marimba E4', JSON.stringify(got));
  check('A pitched recording comes back pitched, at its note', got.pitched === true && got.root === 64 && got.layers[0] === 'partials', `${got.pitched} root ${got.root}`);

  // 2. ...and sounds like it: compare the recording with the resynthesis in the page
  const distance = await page.evaluate(async () => {
    const S = await import(window.__fs + '/packages/sound/src/index.ts');
    const st = window.__dawStore.getState();
    const r = st.tracks.find((x) => x.id === st.selectedTrackId).instrument.parameters.Library.sound;
    const source = S.render(S.findSound('marimba'), { note: 64, sampleRate: 44100 }); // as the WAV was made
    const out = S.render(r, { note: 64, sampleRate: 44100, normalize: false });
    const mono = (x) => x.left.map((v, i) => (v + x.right[i]) / 2);
    return S.spectralDistance(mono(source), mono(out), 44100);
  });
  check('The resynthesis sounds like the recording', distance < 3, `${distance.toFixed(2)} dB mean spectrogram difference`);

  // 3. It plays across the keyboard: an octave up sounds an octave up
  const octave = await page.evaluate(async () => {
    const S = await import(window.__fs + '/packages/sound/src/index.ts');
    const st = window.__dawStore.getState();
    const r = st.tracks.find((x) => x.id === st.selectedTrackId).instrument.parameters.Library.sound;
    const { left } = S.render(r, { note: 76, sampleRate: 44100, gate: 0.5 });
    return S.analysis.estimatePitch(left, 44100, 2205, 4096);
  });
  check('The resynthesized sound plays across the keyboard', Math.abs(octave - 659.26) < 4, `E5 → ${octave.toFixed(1)} Hz`);

  // 4. Dropping a recording on the designer: an open hat (48 kHz, 24-bit) comes back unpitched, as noise
  const bytes = fs.readFileSync(`${ctx.fixtures}/Open Hat.wav`).toString('base64');
  await page.evaluate((b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([data], 'Open Hat.wav', { type: 'audio/wav' }));
    document.querySelector('.sound-designer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  for (let i = 0; i < 40 && (got = await sound()).name !== 'Open Hat'; i++) await ctx.sleep(250);
  check('Dropping a recording on the designer resynthesizes it', got.name === 'Open Hat' && got.pitched === false && got.layers.includes('noise'), JSON.stringify(got));

  // 5. Undo brings the previous sound back
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(200);
  const undone = await sound();
  check('Undo brings back the sound before', undone.name === 'Marimba E4', undone.name);

  await ctx.sleep(500);
  await ctx.shot('resynth');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
