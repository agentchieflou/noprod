// #143: names for every control, visible focus, and keyboard use. axe-core
// (a dev-only tool, never shipped) audits the main views; the rest check the
// keyboard behaviour axe can't see.
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);
  await page.addScriptTag({ path: require.resolve('axe-core') });

  // Colour contrast is a design question (the palette stays as it is), so it is left out
  const audit = (selector) => page.evaluate(async (selector) => {
    const r = await window.axe.run(selector ? document.querySelector(selector) : document, { rules: { 'color-contrast': { enabled: false } } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, selector);
  const clickText = (sel, text) => page.evaluate((sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === text).click(), sel, text);
  const view = async (name, open, selector, wait = 600) => {
    await open();
    await ctx.sleep(wait);
    const all = await audit(selector);
    const bad = all.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const count = bad.reduce((n, v) => n + v.nodes, 0);
    if (process.env.A11Y_VERBOSE) for (const v of all) console.error(`  ${name}: ${v.id} (${v.impact}) x${v.nodes} ${v.sample.join(' | ')}`);
    console.error(`axe ${name}: ${count} critical/serious nodes in ${bad.length} rules, ${all.length} rules in all`);
    check(`${name}: no critical or serious axe violations`, bad.length === 0, bad.map((v) => `${v.id} x${v.nodes}`).join(', '));
  };

  try {
    await view('Arrangement and Device Chain', () => clickText('.detail-tab', 'Device Chain'));
    await view('Clip View', () => clickText('.detail-tab', 'Clip View'));
    await view('Sound Designer', () => clickText('.detail-tab', 'Sound Designer'));
    await view('DSP Map', () => clickText('.detail-tab', 'DSP Map'));
    await view('Mixer', () => clickText('.detail-tab', 'Mixer'));
    await view('Session View', async () => { await clickText('.detail-tab', 'Device Chain'); await page.click('button[title="Session View"]'); });
    await page.click('button[title="Arrangement View"]');

    // The Services dialog: Tab stays inside, Escape closes it and gives focus back
    const servicesButton = '.btn-metronome[title^="Turn the local GhostDAW"]';
    await page.focus(servicesButton);
    await page.keyboard.press('Enter');
    await ctx.sleep(300);
    await view('Services dialog', async () => {}, '.services-dialog');
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('.services-dialog'));
    check('The Services dialog takes focus when it opens', await inside());
    let stayed = true;
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); stayed = stayed && await inside(); }
    for (let i = 0; i < 12; i++) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); stayed = stayed && await inside(); }
    check('Tab and Shift+Tab stay inside the open dialog', stayed);
    await page.keyboard.press('Escape');
    await ctx.sleep(200);
    check('Escape closes the dialog', !(await page.$('.services-dialog')));
    check('Focus returns to the button that opened it', await page.evaluate((sel) => document.activeElement === document.querySelector(sel), servicesButton));

    // The dictation settings dialog, opened from the control bar
    await page.focus('[data-dictation-key]');
    await page.keyboard.press('Enter');
    await ctx.sleep(300);
    await view('Dictation settings dialog', async () => {}, '[data-dictation-settings]');
    const inDictation = () => page.evaluate(() => !!document.activeElement?.closest('[data-dictation-settings]'));
    let held = await inDictation();
    for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); held = held && await inDictation(); }
    check('The dictation dialog takes focus and Tab stays inside it', held);
    await page.keyboard.press('Escape');
    await ctx.sleep(200);
    check('Escape closes the dictation dialog and focus goes back to its button',
      !(await page.$('[data-dictation-settings]')) && await page.evaluate(() => document.activeElement === document.querySelector('[data-dictation-key]')));

    // Focus is visible: a ring on whatever Tab lands on, and on the search box's frame
    await page.evaluate(() => document.activeElement?.blur());
    const rings = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      rings.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body';
        if (el.closest('.browser-search')) return ''; // its frame shows focus, checked below
        const cs = getComputedStyle(el);
        return cs.outlineStyle === 'solid' && parseFloat(cs.outlineWidth) >= 2 ? '' : `${el.tagName}.${el.className}`;
      }));
    }
    check('Every control Tab reaches shows the focus ring', rings.every((r) => r === ''), [...new Set(rings.filter(Boolean))].join(', '));
    await page.focus('.browser-search input');
    check('The browser search box shows focus on its frame', await page.evaluate(() => getComputedStyle(document.querySelector('.browser-search')).outlineStyle !== 'none'));

    // Space belongs to the focused control, not the transport
    const playing = () => page.evaluate(() => window.__dawStore.getState().isPlaying);
    const spaceOn = async (selector) => {
      await page.focus(selector);
      await page.keyboard.press('Space');
      await ctx.sleep(300);
      return playing();
    };
    check('Space on a focused button does not start the transport', !(await spaceOn('.btn-metronome[title^="Turn the local GhostDAW"]')));
    await page.keyboard.press('Escape');
    check('Space on a focused select does not start the transport', !(await spaceOn('.tempo-controls select')));
    check('Space on a focused slider does not start the transport', !(await spaceOn('.master-fader input[type=range]')));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Space');
    await ctx.sleep(300);
    check('Space with nothing focused still starts the transport', await playing());
    await page.keyboard.press('Space');
    await ctx.sleep(300);
    check('and stops it again', !(await playing()));

    // The plug-in editor canvas takes keys, so Escape is the way out
    // (a port that accepts and says nothing, so the stream stays pending and the window stays open)
    const quiet = require('net').createServer((sock) => sock.on('error', () => {}));
    await new Promise((done) => quiet.listen(0, '127.0.0.1', done));
    await page.evaluate(async (port) => {
      const m = await import('/src/native/pluginEditor.ts');
      m.showPluginEditor({ editorId: 'e2e', slotId: 's', name: 'Test editor', port, width: 200, height: 100, scale: 1, keyboard: true }, () => {}, true);
    }, quiet.address().port);
    await page.waitForSelector('canvas.plugin-editor-canvas', { timeout: 10000 });
    await view('Plug-in editor', async () => {}, '.plugin-editor-window', 0);
    await page.focus('canvas.plugin-editor-canvas');
    check('The editor canvas holds keyboard focus', await page.evaluate(() => document.activeElement?.className === 'plugin-editor-canvas'));
    await page.keyboard.press('Escape');
    check('Escape leaves the canvas for the editor window',
      await page.evaluate(() => document.activeElement?.getAttribute('role') === 'dialog'));
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    check('and Shift+Tab goes on from there', await page.evaluate(() => !document.activeElement?.closest('.plugin-editor-window')));

    quiet.close();

    const errors = (await ctx.logs).filter((l) => /^\[pageerror\]/.test(l));
    check('No page errors', errors.length === 0, errors.join('; '));
  } catch (e) {
    check('a11y suite ran', false, e.message);
  }
  return results;
};
