// The license check guards our licensing rule, so it has tests of its own:
// synthetic lockfiles that must pass or fail.
//   node --test scripts/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed, check } from './check-licenses.mjs';

const THIRD_PARTY = '| `apps/audio_core/third_party/lpi` | the LPI header | MIT |';

// workspaces: { 'apps/x': { dependencies, devDependencies } }; licenses by
// package name, hoisted to the top node_modules
function run({ workspaces, licenses, thirdPartyDirs = ['lpi'], thirdPartyMd = THIRD_PARTY, gitmodules = '' }) {
  const packages = { '': { name: 'root' } };
  for (const [loc, w] of Object.entries(workspaces)) packages[loc] = w;
  for (const name of Object.keys(licenses)) packages[`node_modules/${name}`] = { version: '1.0.0' };
  return check({
    lock: { packages },
    readMeta: (loc) => (loc.startsWith('node_modules/') ? { license: licenses[loc.slice(13)] } : null),
    thirdPartyDirs,
    thirdPartyMd,
    gitmodules,
  });
}

const app = (deps, extra = {}) => ({ 'apps/frontend': { dependencies: deps }, ...extra });

test('permissive licenses pass', () => {
  const r = run({ workspaces: app({ a: '*', b: '*' }), licenses: { a: 'MIT', b: '(MIT OR Apache-2.0)' } });
  assert.deepEqual(r.failures, []);
});

test('a GPL package fails, with its path', () => {
  const r = run({ workspaces: app({ a: '*' }), licenses: { a: 'GPL-3.0-only' } });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /^a@1\.0\.0 is GPL-3\.0-only: apps\/frontend > a$/);
});

test('a GPL dev dependency is reported, not failed', () => {
  const r = run({
    workspaces: { 'apps/frontend': { dependencies: { a: '*' }, devDependencies: { b: '*' } } },
    licenses: { a: 'MIT', b: 'GPL-3.0-only' },
  });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.devLicenses.get('GPL-3.0-only'), ['b']);
});

test('the Strudel exception covers packages reached only from apps/sequencer', () => {
  const r = run({
    workspaces: { 'apps/sequencer': { dependencies: { '@strudel/core': '*' } } },
    licenses: { '@strudel/core': 'AGPL-3.0-or-later' },
  });
  assert.deepEqual(r.failures, []);
  assert.equal(r.excepted.length, 1);
});

test('Strudel in another workspace fails, even if the sequencer has it too', () => {
  const r = run({
    workspaces: {
      'apps/sequencer': { dependencies: { '@strudel/core': '*' } },
      'apps/orchestrator': { dependencies: { '@strudel/core': '*' } },
    },
    licenses: { '@strudel/core': 'AGPL-3.0-or-later' },
  });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /apps\/orchestrator > @strudel\/core/);
});

test('an excepted name reached from the frontend fails', () => {
  const r = run({ workspaces: app({ 'hydra-synth': '*' }), licenses: { 'hydra-synth': 'AGPL' } });
  assert.equal(r.failures.length, 1);
});

test('SPDX: AND binds tighter than OR, and parentheses group', () => {
  assert.equal(allowed('GPL-3.0-only AND (MIT OR Apache-2.0)'), false);
  assert.equal(allowed('(MIT OR Apache-2.0) AND ISC'), true);
  assert.equal(allowed('MIT OR GPL-3.0-only'), true);
  assert.equal(allowed('MIT AND GPL-3.0-only'), false);
  assert.equal(allowed('GPL-3.0-only OR MIT AND ISC'), true);
  assert.equal(allowed('GPL-3.0-only AND MIT OR GPL-2.0-only'), false);
  assert.equal(allowed('MIT WITH Classpath-exception-2.0'), false);
  assert.equal(allowed('(MIT'), false);
  assert.equal(allowed('MIT OR'), false);
  assert.equal(allowed(''), false);
});

test('a mixed expression fails through the check', () => {
  const r = run({ workspaces: app({ a: '*' }), licenses: { a: 'GPL-3.0-only AND (MIT OR Apache-2.0)' } });
  assert.equal(r.failures.length, 1);
});

test('a vendored directory must be listed exactly, not as a prefix', () => {
  const r = run({ workspaces: app({}), licenses: {}, thirdPartyDirs: ['lpi', 'lp'] });
  assert.deepEqual(r.failures, ['apps/audio_core/third_party/lp is not listed in THIRD_PARTY.md']);
});

test('submodules: restricted ones are exceptions, permissive ones are listed', () => {
  const gitmodules = '[submodule "a"]\n\tpath = apps/audio_core/JUCE\n[submodule "b"]\n\tpath = vendor/vst3sdk\n';
  const listed = run({ workspaces: app({}), licenses: {}, gitmodules, thirdPartyMd: THIRD_PARTY + '\n| `vendor/vst3sdk` | MIT |' });
  assert.deepEqual(listed.failures, []);
  const unlisted = run({ workspaces: app({}), licenses: {}, gitmodules });
  assert.deepEqual(unlisted.failures, ['submodule vendor/vst3sdk is neither listed in THIRD_PARTY.md nor an exception']);
});

test('a package that isn\'t installed falls back to the lockfile\'s license', () => {
  const packages = { '': {}, 'apps/frontend': { dependencies: { a: '*', b: '*' } }, 'node_modules/a': { license: 'GPL-3.0-only' }, 'node_modules/b': {} };
  const r = check({ lock: { packages }, readMeta: () => null, thirdPartyDirs: [], thirdPartyMd: '', gitmodules: '' });
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0], /^a@undefined is GPL-3\.0-only/);
  assert.match(r.failures[1], /^b@undefined is NOT INSTALLED/);
});
