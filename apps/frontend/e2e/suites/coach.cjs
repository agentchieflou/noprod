// #83: the Keyboard Coach on the keyboard panel, from the computer keyboard,
// MIDI and on-screen clicks
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  // Start from nothing saved
  await page.evaluate(() => { localStorage.removeItem('noprod-coach'); return 1; });
  await page.reload({ waitUntil: 'networkidle0' });

  // Modules first (a dynamic import after selecting a track can hang), then the MIDI track
  const setup = async () => {
    await page.evaluate(async () => {
      window.__kb = await import('/src/audio/computerKeyboard.ts');
      window.__inputs = await import('/src/audio/inputs.ts');
      window.__coach = await import('/src/audio/coach.ts');
      return 1;
    });
    await page.evaluate(() => {
      const st = window.__dawStore.getState();
      st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
      return 1;
    });
  };
  await setup();

  const panel = () => page.evaluate(() => ({
    panel: !!document.querySelector('.kb-panel'),
    coach: !!document.querySelector('.kb-coach'),
    controls: !!document.querySelector('.kb-controls'),
    piano: !!document.querySelector('.kb-piano'),
    letters: document.querySelectorAll('.kb-piano .kb-key-label').length
  }));
  const readout = () => page.evaluate(() => document.querySelector('.coach-message')?.textContent ?? '');
  const marked = (role) => page.evaluate((role) => [...document.querySelectorAll(`.kb-piano .coach-${role}`)].map((k) => ({
    pitch: +k.dataset.pitch,
    glow: +k.dataset.glow,
    opacity: +getComputedStyle(k.querySelector('.kb-mark')).opacity,
    mark: getComputedStyle(k).getPropertyValue('--mark').trim(),
    animation: getComputedStyle(k.querySelector('.kb-mark')).animationName,
    letter: k.querySelector('.kb-key-label')?.textContent ?? '',
    lit: k.classList.contains('lit')
  })), role);
  const clickMode = async (label) => {
    await page.evaluate((label) => [...document.querySelectorAll('.coach-modes button')].find((b) => b.textContent === label).click(), label);
    await ctx.sleep(100);
  };
  const publish = (type, pitches) => page.evaluate((type, pitches) => {
    for (const pitch of pitches) window.__inputs.publishMidi({ type, pitch, velocity: type === 'on' ? 0.8 : 0, channel: 1, source: 'test-midi', time: 0 });
    return 1;
  }, type, pitches);
  const keys = async (codes, fn) => {
    for (const c of codes) await page.keyboard.down(c);
    await ctx.sleep(150);
    const out = await fn?.();
    for (const c of codes) await page.keyboard.up(c);
    await ctx.sleep(100);
    return out;
  };
  const blur = () => page.evaluate(() => { document.activeElement?.blur?.(); return 1; });

  // 1. The Coach button opens the panel, computer keyboard off...
  await page.evaluate(() => { window.__kb.setKeyboardEnabled(false); return 1; });
  await ctx.sleep(100);
  const closed = await panel();
  await page.click('.coach-toggle');
  await ctx.sleep(200);
  const offOpen = await panel();
  check('Coach button opens the panel with the keyboard off', !closed.panel && offOpen.panel && offOpen.coach && !offOpen.controls && offOpen.piano,
    JSON.stringify({ closed, offOpen }));
  check('With the keyboard off the keys show no letters', offOpen.letters === 0, `${offOpen.letters} letters`);
  await ctx.shot('coach_kb_off');

  // ...where an on-screen click still reaches the coach
  const at = await page.evaluate(() => {
    const r = document.querySelector('.kb-white[data-pitch="60"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 10 };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await ctx.sleep(150);
  const heldNow = () => page.evaluate(() => ({
    held: window.__coach.getCoachState().highlights.filter((h) => h.role === 'held').map((h) => h.pitch),
    lit: document.querySelector('.kb-white[data-pitch="60"]').classList.contains('lit')
  }));
  const down = await heldNow();
  await page.mouse.up();
  await ctx.sleep(150);
  const up = await heldNow();
  const click = { held: down.held.join() === '60', lit: down.lit, after: up.held.length > 0 || up.lit };
  check('An on-screen click reaches the coach', click.held && click.lit && !click.after, JSON.stringify(click));

  await page.click('.coach-toggle');
  await ctx.sleep(150);
  const reClosed = await panel();
  // ...and with the keyboard on
  await page.evaluate(() => { window.__kb.setKeyboardEnabled(true); return 1; });
  await ctx.sleep(100);
  const kbOnly = await panel();
  await page.click('.coach-toggle');
  await ctx.sleep(200);
  const onOpen = await panel();
  check('Coach button toggles; with the keyboard on both show', !reClosed.panel && kbOnly.panel && !kbOnly.coach && onOpen.coach && onOpen.controls && onOpen.piano,
    JSON.stringify({ reClosed, kbOnly, onOpen }));
  const activeMode = await page.evaluate(() => document.querySelector('.coach-modes .active')?.textContent);
  check('Chords is the default mode', activeMode === 'Chords', activeMode);

  // 2. Chords mode from the computer keyboard: Z C B is C3 E3 G3
  const chordC = await keys(['KeyZ', 'KeyC', 'KeyB'], async () => {
    await ctx.shot('coach_chords_held');
    return {
      text: await readout(),
      next: await marked('next'),
      lit: await page.evaluate(() => [48, 52, 55].every((p) => document.querySelector(`.kb-piano [data-pitch="${p}"]`).classList.contains('lit'))),
      suggestions: await page.evaluate(() => window.__coach.getCoachState().readout.suggestions)
    };
  });
  check('Readout names C (I)', chordC.text.startsWith('C (I) → try'), chordC.text);
  check('Held keys light up', chordC.lit);
  check('Next-chord keys light with the role class', chordC.next.length >= 3, chordC.next.map((k) => `${k.pitch}:${k.glow}`).join(' '));
  const top = chordC.suggestions[0];
  const strongest = chordC.next.filter((k) => k.glow === 1).map((k) => k.pitch);
  const weaker = chordC.next.filter((k) => !k.lit && k.glow < 1);
  const topUnheld = chordC.next.filter((k) => !k.lit && k.glow === 1);
  check('The likeliest chord glows strongest', top && top.pitches.every((p) => strongest.includes(p)) && weaker.length > 0
    && topUnheld.every((k) => weaker.every((w) => k.opacity > w.opacity)),
    `top ${top?.label} ${JSON.stringify(top?.pitches)}; full glow ${strongest}; opacities ${chordC.next.map((k) => k.opacity.toFixed(2)).join(' ')}`);
  check('Highlighted keys show their letters', chordC.next.every((k) => k.letter.trim().length > 0), chordC.next.map((k) => k.letter).join(' '));
  const chips = await page.evaluate(() => [...document.querySelectorAll('.coach-chip')].map((c) => c.textContent));
  check('The suggestions are listed', chips.length === chordC.suggestions.length && chips[0] === chordC.suggestions[0].label, chips.join(' | '));
  // Pointing at a suggestion shows only its keys
  await page.hover('.coach-chip:nth-child(2)');
  await ctx.sleep(100);
  const focusedPitches = (await marked('next')).map((k) => k.pitch);
  await ctx.shot('coach_chords_focus');
  await page.mouse.move(800, 300);
  await ctx.sleep(100);
  const focused = { pitches: focusedPitches, after: (await marked('next')).length };
  check('Pointing at a suggestion shows only its keys', JSON.stringify(focused.pitches) === JSON.stringify(chordC.suggestions[1].pitches) && focused.after === chordC.next.length,
    JSON.stringify(focused));

  // 3. The MIDI path: G/B, then Am
  await publish('on', [59, 62, 67]);
  await ctx.sleep(150);
  const gb = await readout();
  await publish('off', [59, 62, 67]);
  await ctx.sleep(50);
  await publish('on', [57, 60, 64]);
  await ctx.sleep(150);
  const am = await readout();
  const midiLit = await page.evaluate(() => [57, 60, 64].every((p) => document.querySelector(`.kb-piano [data-pitch="${p}"]`).classList.contains('lit')));
  await ctx.shot('coach_midi_am');
  await publish('off', [57, 60, 64]);
  await ctx.sleep(100);
  check('MIDI: G/B reads as G/B (V)', /^G\/B \(V/.test(gb), gb);
  check('MIDI: Am reads "Am (vi) → try F (IV) …"', /^Am \(vi\) → try F \(IV\)/.test(am), am);
  check('MIDI notes light the keys too', midiLit);

  // 4. Complement mode: C + E held lights G as a complement
  await clickMode('Complement');
  const comp = await keys(['KeyZ', 'KeyC'], async () => {
    await ctx.shot('coach_complement');
    return { marks: await marked('complement'), next: await marked('next'), text: await readout() };
  });
  const g = comp.marks.find((k) => k.pitch % 12 === 7);
  check('Complement: C+E lights G', !!g && comp.next.length === 0, `${comp.text} / ${comp.marks.map((k) => `${k.pitch}:${k.glow}`).join(' ')}`);
  check('Complements have their own color', !!g && g.mark && chordC.next[0].mark && g.mark !== chordC.next[0].mark, `${g?.mark} vs ${chordC.next[0].mark}`);

  // 5. Melody mode: next-note highlights
  await clickMode('Melody');
  await keys(['KeyZ']);
  await keys(['KeyX']);
  const mel = await keys(['KeyC'], async () => ({ marks: await marked('next'), text: await readout() }));
  const melAfter = await marked('next');
  check('Melody: next notes light up', mel.marks.length >= 2 && melAfter.length >= 2 && mel.text.startsWith('Next:'), `${mel.text} / ${melAfter.map((k) => `${k.pitch}:${k.glow}`).join(' ')}`);
  await ctx.shot('coach_melody');

  // In the keyboard's Scale mode the keys are pads: the coach says where its highlights are
  await page.evaluate(() => { window.__kb.setKeyboardMode('scale'); return 1; });
  await ctx.sleep(150);
  const scale = await page.evaluate(() => ({ piano: !!document.querySelector('.kb-piano'), hint: !!document.querySelector('.coach-link') }));
  await page.click('.coach-link');
  await ctx.sleep(150);
  const back = await page.evaluate(() => ({ piano: !!document.querySelector('.kb-piano'), mode: window.__kb.getKeyboardState().mode }));
  check('Scale mode: the coach offers to switch to the piano', !scale.piano && scale.hint && back.piano && back.mode === 'piano', JSON.stringify({ scale, back }));

  // 6. Lessons
  await clickMode('Lessons');
  const pick = await page.evaluate(() => document.querySelector('.coach-message')?.textContent);
  await page.select('.coach-select', 'pop-c');
  await blur();
  await ctx.sleep(150);
  const progress = () => page.evaluate(() => document.querySelector('.coach-progress')?.textContent ?? '');
  const p1 = await progress();
  const targets = await marked('target');
  check('Lessons: picking a lesson shows step 1', pick === 'Pick a lesson' && p1.startsWith('Step 1 / 4') && p1.includes('C (I)'), `${pick} → ${p1}`);
  const targetLabels = await page.evaluate(() => [...document.querySelectorAll('.kb-piano .coach-target .kb-coach-label')].map((l) => l.textContent).join(' '));
  check('Lesson targets are named note by note', targetLabels === 'C E G', targetLabels);
  check('Lesson targets pulse', targets.length === 3 && targets.every((k) => k.animation === 'coach-pulse') && targets.map((k) => k.pitch % 12).sort().join() === '0,4,7',
    targets.map((k) => `${k.pitch}:${k.animation}`).join(' '));
  await ctx.shot('coach_lesson_step1');
  await keys(['KeyZ', 'KeyC', 'KeyB']);   // C E G
  const p2 = await progress();
  check('The right chord advances the step', p2.startsWith('Step 2 / 4') && p2.includes('G (V)'), p2);
  const wrong = await keys(['KeyS'], async () => { await ctx.shot('coach_lesson_wrong'); return marked('wrong'); });   // C#: not in G
  check('A wrong note flashes', wrong.length === 1 && wrong[0].pitch === 49 && wrong[0].animation === 'coach-flash', JSON.stringify(wrong));
  const wrongAfter = await marked('wrong');
  check('The wrong mark goes when the note is let go', wrongAfter.length === 0 && (await progress()).startsWith('Step 2 / 4'));
  await page.click('.coach-restart');
  await blur();
  await ctx.sleep(100);
  const p3 = await progress();
  check('Restart goes back to step 1', p3.startsWith('Step 1 / 4'), p3);
  await keys(['KeyZ', 'KeyC', 'KeyB']);       // C
  await keys(['KeyB', 'KeyM', 'Period']);     // G B D
  await keys(['KeyZ', 'KeyC', 'KeyN']);       // C E A
  const p4 = await progress();
  await keys(['KeyZ', 'KeyV', 'KeyN']);       // C F A
  const done = await page.evaluate(() => ({
    done: !!document.querySelector('.coach-readout.done'),
    text: document.querySelector('.coach-readout').textContent,
    targets: document.querySelectorAll('.kb-piano .coach-target').length
  }));
  check('Finishing the lesson shows done', p4.startsWith('Step 4 / 4') && done.done && done.text.includes('Done!') && done.targets === 0, `${p4} → ${done.text}`);
  await ctx.shot('coach_lesson_done');

  // 7. Settings persist: a fixed key in chords mode, then the lesson
  await clickMode('Chords');
  await page.select('.coach-select', '9');   // A major
  await blur();
  await ctx.sleep(100);
  const fixedKey = await page.evaluate(() => document.querySelector('.coach-key')?.textContent);
  await clickMode('Lessons');
  const saved = await page.evaluate(() => localStorage.getItem('noprod-coach'));
  await page.reload({ waitUntil: 'networkidle0' });
  await setup();
  await page.click('.coach-toggle');
  await ctx.sleep(200);
  const restored = await page.evaluate(() => ({
    mode: document.querySelector('.coach-modes .active')?.textContent,
    lesson: document.querySelector('.coach-select')?.value,
    progress: document.querySelector('.coach-progress')?.textContent
  }));
  await clickMode('Chords');
  const restoredKey = await page.evaluate(() => ({ select: document.querySelector('.coach-select')?.value, badge: document.querySelector('.coach-key')?.textContent }));
  check('A fixed key shows in the readout', fixedKey === 'A major', fixedKey);
  check('Mode, key and lesson persist across a reload', restored.mode === 'Lessons' && restored.lesson === 'pop-c' && restored.progress.startsWith('Step 1 / 4')
    && restoredKey.select === '9' && restoredKey.badge === 'A major', `${saved} → ${JSON.stringify({ ...restored, ...restoredKey })}`);
  await page.select('.coach-select', 'auto');
  await blur();

  // 8. No page errors
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080')); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
