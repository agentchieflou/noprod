// The computer MIDI keyboard: real key presses play the right pitches on the
// selected MIDI track, in each mode, with octave and velocity keys
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  // Modules first (a dynamic import after selecting a track can hang), then the track
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__kb = await import('/src/audio/computerKeyboard.ts');
    window.__inputs = await import('/src/audio/inputs.ts');
    window.__lib = await import('/src/audio/library.ts');
    window.__sound = await import(window.__fs + '/packages/sound/src/index.ts');
    window.__events = [];
    window.__inputs.onMidiEvent((e) => window.__events.push(e));
    return 1;
  });
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
    window.__kb.setKeyboardEnabled(true);
    window.__kb.setKeyboardMode('auto');
    window.__kb.setOctave(3);
    window.__kb.setVelocity(0.8);
    return 1;
  });
  await ctx.sleep(200);

  const clear = () => page.evaluate(() => { window.__events.length = 0; return 1; });
  const events = () => page.evaluate(() => window.__events.map((e) => ({ type: e.type, pitch: e.pitch, velocity: e.velocity, source: e.source, targets: e.targets })));
  const tap = async (code, opts = {}) => {
    if (opts.shift) await page.keyboard.down('ShiftLeft');
    await page.keyboard.down(code);
    await ctx.sleep(60);
    await page.keyboard.up(code);
    if (opts.shift) await page.keyboard.up('ShiftLeft');
    await ctx.sleep(60);
  };
  const ons = async () => (await events()).filter((e) => e.type === 'on');
  const kb = () => page.evaluate(() => { const s = window.__kb.getKeyboardState(); return { octave: s.octave, velocity: s.velocity, mode: s.mode, sounding: s.sounding }; });
  const trackId = await page.evaluate(() => window.__dawStore.getState().selectedTrackId);

  // 1. Piano: Z is C3 (48), S is C#3, Q is C4 (60); events carry the target track and an off follows each on
  await clear();
  await tap('KeyZ'); await tap('KeyS'); await tap('KeyQ'); await tap('Digit2');
  const piano = await events();
  check('Piano mode plays Z, S, Q, 2 as C3, C#3, C4, C#4',
    JSON.stringify(piano.filter((e) => e.type === 'on').map((e) => e.pitch)) === '[48,49,60,61]', JSON.stringify(piano.filter((e) => e.type === 'on').map((e) => e.pitch)));
  check('Each key-up releases its pitch, and notes go to the selected track',
    piano.filter((e) => e.type === 'off').map((e) => e.pitch).join() === '48,49,60,61' && piano.every((e) => e.source === 'computer' && e.targets?.join() === trackId));

  // 2. Held keys sound together, shown in the panel's state
  await clear();
  await page.keyboard.down('KeyZ'); await page.keyboard.down('KeyC'); await page.keyboard.down('KeyB');
  await ctx.sleep(100);
  const chord = await kb();
  const lit = await page.evaluate(() => [...document.querySelectorAll('.kb-piano .lit')].map((k) => +k.dataset.pitch).sort((a, b) => a - b));
  await page.keyboard.up('KeyZ'); await page.keyboard.up('KeyC'); await page.keyboard.up('KeyB');
  await ctx.sleep(100);
  const after = await kb();
  check('Held keys sound together and light up on the panel', chord.sounding.slice().sort((a, b) => a - b).join() === '48,52,55' && lit.join() === '48,52,55', `${chord.sounding} / ${lit}`);
  check('Releasing the keys clears the sounding notes', after.sounding.length === 0);

  // 3. Octave keys: → goes up one, ← down, and it clamps at 0..7
  await tap('ArrowRight');
  await clear(); await tap('KeyZ');
  const up = await ons();
  await tap('ArrowLeft'); await tap('ArrowLeft');
  await clear(); await tap('KeyZ');
  const down = await ons();
  await tap('ArrowRight');
  const state1 = await kb();
  await page.evaluate(() => { window.__kb.setOctave(99); return 1; });
  const top = (await kb()).octave;
  await page.evaluate(() => { window.__kb.setOctave(-5); return 1; });
  const bottom = (await kb()).octave;
  await page.evaluate(() => { window.__kb.setOctave(3); return 1; });
  check('Arrow keys move the octave and the pitches with it', up[0]?.pitch === 60 && down[0]?.pitch === 36 && state1.octave === 3, `${up[0]?.pitch} ${down[0]?.pitch} octave ${state1.octave}`);
  check('The octave is clamped to 0..7', top === 7 && bottom === 0, `${bottom}..${top}`);

  // 4. Velocity keys, Shift accent and the velocity in the events
  await page.evaluate(() => { window.__kb.setVelocity(0.8); return 1; });
  await tap('ArrowDown'); await tap('ArrowDown');
  const lower = (await kb()).velocity;
  await clear(); await tap('KeyZ');
  const soft = (await ons())[0];
  await tap('ArrowUp');
  const higher = (await kb()).velocity;
  await clear(); await tap('KeyZ', { shift: true });
  const accent = (await ons())[0];
  await page.evaluate(() => { window.__kb.setVelocity(0.01); return 1; });
  const floor = (await kb()).velocity;
  check('Down arrow lowers velocity by 0.1 and notes carry it', Math.abs(lower - 0.6) < 0.01 && Math.abs(soft.velocity - 0.6) < 0.01, `${lower} ${soft?.velocity}`);
  check('Up arrow raises velocity; Shift plays an accent at full', Math.abs(higher - 0.7) < 0.01 && accent.velocity === 1, `${higher} ${accent?.velocity}`);
  check('Velocity has a floor of 0.05', floor === 0.05, String(floor));
  await page.evaluate(() => { window.__kb.setVelocity(0.8); return 1; });

  // 5. Esc releases everything held
  await clear();
  await page.keyboard.down('KeyZ'); await page.keyboard.down('KeyV');
  await ctx.sleep(60);
  await page.keyboard.down('Escape'); await page.keyboard.up('Escape');
  await ctx.sleep(60);
  const esc = await events();
  const escState = await kb();
  await page.keyboard.up('KeyZ'); await page.keyboard.up('KeyV');
  check('Esc releases every held note', esc.filter((e) => e.type === 'off').length === 2 && escState.sounding.length === 0, JSON.stringify(esc.map((e) => e.type + e.pitch)));

  // 6. Scale mode: A minor, keys walk the scale; chords stack thirds
  await page.evaluate(() => { window.__kb.setKeyboardMode('scale'); window.__kb.setScale({ root: 9, scale: 'Minor', chords: false }); return 1; });
  await ctx.sleep(100);
  await clear();
  for (const c of ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'KeyQ']) await tap(c);
  const scale = (await ons()).map((e) => e.pitch);
  check('Scale mode walks A minor, then continues up an octave', scale.join() === '57,59,60,62,64,65,67,69,69', scale.join());
  await page.evaluate(() => { window.__kb.setScale({ chords: true }); return 1; });
  await clear(); await tap('KeyZ');
  const triad = (await ons()).map((e) => e.pitch);
  const pads = await page.evaluate(() => [...document.querySelectorAll('.kb-pad-name')].map((p) => p.textContent));
  check('Scale chords play a minor triad on the tonic, and the pads are named', triad.join() === '57,60,64' && pads.includes('Am'), `${triad} / ${pads.slice(0, 4)}`);
  await page.evaluate(() => { window.__kb.setScale({ chords: false, root: 0, scale: 'Major' }); return 1; });
  await clear(); await tap('KeyZ'); await tap('KeyB');
  const major = (await ons()).map((e) => e.pitch);
  check('Changing key and scale changes the pitches', major.join() === '48,55', major.join());

  // 7. Drums mode: pads are fixed notes; the Q row repeats them
  await page.evaluate(() => { window.__kb.setKeyboardMode('drums'); return 1; });
  await ctx.sleep(100);
  await clear();
  for (const c of ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyQ', 'KeyR']) await tap(c);
  const drums = (await ons()).map((e) => e.pitch);
  const names = await page.evaluate(() => [...document.querySelectorAll('.kb-pad .kb-pad-name')].map((p) => p.textContent));
  check('Drums mode plays kick, snare, clap, closed hat; the Q row repeats them', drums.join() === '36,38,39,42,36,42', drums.join());
  check('Drums pads are named', names.includes('Kick') && names.includes('Snare') && names.includes('Crash'), names.join());
  await clear(); await tap('KeyP');
  check('Keys without a pad make no sound in drums mode', (await events()).length === 0);

  // 8. Auto: piano on a synth track, drums once a library kit is the instrument
  await page.evaluate(() => { window.__kb.setKeyboardMode('auto'); return 1; });
  const synthMode = await page.evaluate(() => window.__kb.effectiveMode(window.__dawStore.getState()));
  const kitTrack = await page.evaluate(() => {
    const { KITS } = window.__sound;
    const kit = KITS.find((k) => k.id === 'kit-808');
    const st = window.__dawStore.getState();
    st.addMidiTrackWithInstrument({ id: 'kb-kit', name: '808', type: 'instrument', parameters: { Kit: 'library', Gain: 1, Tune: 0, Library: { kit, sounds: window.__lib.kitSounds(kit) } } }, '808 Kit');
    return window.__dawStore.getState().selectedTrackId;
  });
  await ctx.sleep(200);
  const kitMode = await page.evaluate(() => window.__kb.effectiveMode(window.__dawStore.getState()));
  const label = await page.evaluate(() => document.querySelector('.kb-segment .active')?.textContent);
  await clear(); await tap('KeyZ');
  const kitEvents = await events();
  check('Auto is piano on a synth and drums on a library kit', synthMode === 'piano' && kitMode === 'drums' && label === 'Auto (Drums)', `${synthMode} → ${kitMode}, "${label}"`);
  check('Kit notes go to the kit track', kitEvents[0]?.pitch === 36 && kitEvents[0].targets?.join() === kitTrack, JSON.stringify(kitEvents[0]));

  // 9. Typing in a field doesn't play notes; the keyboard off plays nothing
  await page.evaluate(() => { window.__kb.setKeyboardMode('piano'); const i = document.createElement('input'); i.id = 'kb-test-input'; document.body.appendChild(i); i.focus(); return 1; });
  await clear(); await tap('KeyZ');
  const typed = await events();
  await page.evaluate(() => { document.getElementById('kb-test-input').remove(); window.__kb.setKeyboardEnabled(false); return 1; });
  await clear(); await tap('KeyZ');
  const off = await events();
  check('No notes while typing in a field, or with the keyboard off', typed.length === 0 && off.length === 0, `${typed.length} / ${off.length}`);
  await ctx.shot('keyboard');

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l)); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
