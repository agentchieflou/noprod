// Resilience: a failing panel stays in its panel, audio that can't start says
// so, the start prompt works under the real autoplay policy, a denied
// microphone is explained, and nothing calls alert(). Launched without the
// autoplay flag (NO_AUTOPLAY in run.mjs).
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
  const text = (p, sel) => p.$eval(sel, (el) => el.textContent).catch(() => null);

  await page.evaluate(() => { window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); }; return 1; });

  // --- the start prompt, then audio running
  await page.waitForSelector('.audio-bar', { timeout: 10000 }).catch(() => {});
  const prompt = await page.$('.audio-bar button');
  check('start prompt shows while the audio context is suspended', !!prompt, await text(page, '.audio-bar'));
  const before = await page.evaluate(async () => (await import('/src/audio/engine.ts')).audioContext.state);
  check('the context starts suspended without autoplay', before !== 'running', before);
  await prompt?.click();
  await page.waitForFunction(async () => (await import('/src/audio/engine.ts')).audioContext.state === 'running', { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(async () => (await import('/src/audio/engine.ts')).audioContext.state);
  check('clicking the prompt starts audio', after === 'running', after);
  check('the prompt goes away once audio runs', (await page.$('.audio-bar')) === null);

  // --- a panel that throws on render
  await page.evaluate(async () => { window.__notify = await import('/src/notify.ts'); return 1; });
  const tabs = await page.$$('.detail-tab');
  await page.evaluate(() => { window.__notify.setPanelFault('devices', true); return 1; });
  await ctx.sleep(300);
  const err = await text(page, '[data-panel-error="devices"]');
  check('a panel that throws shows "This panel hit an error"', !!err && err.includes('This panel hit an error'), err ?? 'no error panel');
  check('the rest of the app still renders', !!(await page.$('.control-bar')) && !!(await page.$('.detail-tabs')));
  await tabs[1]?.click();
  await ctx.sleep(300);
  check('other panels still work', (await page.$('[data-panel-error]')) === null && !!(await page.$('.clip-properties-view')));
  await tabs[0]?.click();
  await ctx.sleep(300);
  check('the failed panel stays failed while the fault lasts', !!(await page.$('[data-panel-error="devices"]')));
  await page.evaluate(() => { window.__notify.setPanelFault('devices', false); return 1; });
  await page.click('[data-panel-error="devices"] button');
  await ctx.sleep(300);
  check('Reload brings the panel back', (await page.$('[data-panel-error]')) === null);

  // --- a denied microphone is explained
  await page.evaluate(async () => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    window.__inputs = await import('/src/audio/inputs.ts');
    return 1;
  });
  await page.evaluate(() => { window.__inputs.openAudioInput('mic-denied'); return 1; });
  await page.waitForSelector('.notice-error', { timeout: 5000 }).catch(() => {});
  const notice = await text(page, '.notice-error');
  check('a denied microphone shows what to do', !!notice && /microphone/i.test(notice) && /allow/i.test(notice), notice ?? 'no notice');

  // --- a guarded action reports its failure instead of rejecting
  const rejected = await page.evaluate(async () => {
    let unhandled = false;
    window.addEventListener('unhandledrejection', () => { unhandled = true; });
    await window.__notify.guarded('Testing', () => Promise.reject(new Error('boom')))();
    await new Promise((r) => setTimeout(r, 100));
    return unhandled;
  });
  check('a guarded action fails into a notice, not an unhandled rejection', !rejected && /Testing failed: boom/.test(await text(page, '.notices') ?? ''));

  // --- an uncaught error and a rejection show a notice but don't blank the page
  // (a script of the page's own: errors thrown from evaluate()'d code reach window.onerror without their Error)
  await page.addScriptTag({ content: "setTimeout(() => { throw new Error('stray error'); }); Promise.reject(new Error('stray rejection'));" });
  await ctx.sleep(400);
  const notices = await text(page, '.notices') ?? '';
  check('uncaught errors and rejections show a notice', /stray error/.test(notices) && /stray rejection/.test(notices), notices);
  check('and the app is still there', !!(await page.$('.control-bar')));

  // --- the AudioContext constructor throws: the app still renders and says why
  const broken = await ctx.browser.newPage();
  await broken.setViewport({ width: 1600, height: 1000 });
  const brokenErrors = [];
  broken.on('pageerror', (e) => brokenErrors.push(e.message));
  await broken.evaluateOnNewDocument(() => {
    const fail = function () { throw new DOMException('The audio device is unavailable', 'NotSupportedError'); };
    window.AudioContext = fail; window.webkitAudioContext = fail;
  });
  await broken.goto(ctx.url, { waitUntil: 'networkidle0', timeout: 120000 });
  await broken.waitForSelector('.control-bar', { timeout: 20000 }).catch(() => {});
  check('with no AudioContext the app still renders', !!(await broken.$('.control-bar')));
  const why = await text(broken, '.audio-bar-error');
  check('and says why audio is unavailable', !!why && /audio is unavailable/i.test(why), why ?? 'no message');
  check('no start prompt is offered for audio that cannot start', (await broken.$('.audio-bar button')) === null);
  await broken.screenshot({ path: `${ctx.shotDir}/resilience-no-audio.png` });
  check('no page errors without an AudioContext', brokenErrors.length === 0, brokenErrors.join('; '));
  await broken.close();

  // --- alert is never called
  const alerts = await page.evaluate(() => window.__alerts);
  check('alert() is never called', alerts.length === 0 && !ctx.logs.some((l) => l.startsWith('[dialog]')), alerts.join(' | '));

  const errors = ctx.logs.filter((l) => l.startsWith('[pageerror]') && !/ws:\/\/localhost:808\d/.test(l) && !/stray (error|rejection)/.test(l));
  check('No page errors', errors.length === 0, errors.join('; '));

  results.forEach((r) => console.log(r));
};
