import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// CLAUDE.md: nothing restricted by its license ships. The pattern engine
// replaced Strudel (AGPL); this keeps it and what it pulled in out of the
// lockfile, which is what `npm ls --all` installs.
const AGPL = [/^node_modules\/(.*\/)?@strudel\//, /^node_modules\/(.*\/)?superdough$/, /^node_modules\/(.*\/)?supradough$/, /^node_modules\/(.*\/)?@kabelsalat\//, /^node_modules\/(.*\/)?hydra-synth$/];

test('no AGPL package is in the lockfile', () => {
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  const paths = Object.keys(lock.packages);
  assert.ok(paths.length > 100, 'the lockfile lists the install');
  const offenders = paths.filter((p) => AGPL.some((re) => re.test(p)));
  assert.deepEqual(offenders, []);
  assert.ok(!paths.includes('apps/sequencer'), 'the headless sequencer is gone');
  // the packages themselves say so too
  for (const [path, entry] of Object.entries(lock.packages) as [string, { license?: string }][]) {
    if (!path.startsWith('node_modules/')) continue;
    assert.ok(!/AGPL|GPL-3|GPL-2|LGPL|SSPL|BUSL/i.test(entry.license ?? '') || /MIT|BSD|Apache|ISC/.test(entry.license ?? ''), `${path} is ${entry.license}`);
  }
});

test('nothing in the repo imports Strudel', () => {
  for (const file of ['apps/frontend/package.json', 'apps/frontend/e2e/run.mjs', 'package.json']) {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.ok(!/@strudel|superdough|unpkg\.com/.test(text), `${file} mentions Strudel`);
  }
});
