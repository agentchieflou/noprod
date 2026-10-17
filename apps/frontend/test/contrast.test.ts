// #211: the palette in App.css meets WCAG 2.2 AA. A later edit to a variable
// that drops a pair under its ratio fails here, not in someone's eyes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastRatio, readableOn } from '../src/components/contrast.ts';

const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
const v = (name: string) => {
  const m = css.match(new RegExp(`${name}: *(#[0-9a-fA-F]{6})`));
  assert.ok(m, `${name} is a hex colour in App.css`);
  return m[1];
};

// Every surface text sits on, darkest to lightest
const SURFACES = ['--bg-dark', '--bg-panel', '--bg-track', '--bg-device'].map((n) => [n, v(n)] as const);
// Also in use as plain values: the track-list bar, hover and selected rows
const EXTRA = [['#1a1a1a', '#1a1a1a'], ['#353535', '#353535'], ['#3a3a3a', '#3a3a3a']] as const;
const ALL = [...SURFACES, ...EXTRA];

test('text colours reach 4.5:1 on every surface', () => {
  for (const text of ['--text-primary', '--text-secondary']) {
    for (const [name, bg] of ALL) assert.ok(contrastRatio(v(text), bg) >= 4.5, `${text} on ${name}: ${contrastRatio(v(text), bg).toFixed(2)}`);
  }
});

test('the I/O toggle and the + Return button keep their text readable', () => {
  assert.ok(contrastRatio(v('--text-primary'), '#374151') >= 4.5);
  assert.ok(contrastRatio('#000000', css.match(/btn-add-return \{ background-color: (#[0-9a-f]{6})/)![1]) >= 4.5);
});

test('muted text reaches 4.5:1 on the surfaces it is used on', () => {
  for (const [name, bg] of [...SURFACES.slice(0, 3), ['#1a1a1a', '#1a1a1a'], ['#262626', '#262626'], ['#2b2b2b', '#2b2b2b'], ['#151515', '#151515']] as const) {
    assert.ok(contrastRatio(v('--text-muted'), bg) >= 4.5, `--text-muted on ${name}: ${contrastRatio(v('--text-muted'), bg).toFixed(2)}`);
  }
});

test('accents used as text reach 4.5:1 on every surface', () => {
  for (const accent of ['--accent-blue', '--accent-green', '--accent-red']) {
    for (const [name, bg] of ALL) assert.ok(contrastRatio(v(accent), bg) >= 4.5, `${accent} on ${name}: ${contrastRatio(v(accent), bg).toFixed(2)}`);
  }
});

test('the fills behind light text reach 4.5:1 with it', () => {
  for (const fill of ['--accent-blue-fill', '--accent-red-fill']) {
    for (const text of [v('--text-primary'), '#ffffff']) assert.ok(contrastRatio(text, v(fill)) >= 4.5, `${text} on ${fill}: ${contrastRatio(text, v(fill)).toFixed(2)}`);
  }
});

test('the coach colours reach 3:1 on the keys they mark, and 4.5:1 as text in the coach column', () => {
  const white = '#e5e7eb', black = '#1f1f1f', column = '#151515';
  const roles = ['next', 'complement', 'target', 'wrong'];
  const panel = (name: string) => css.match(new RegExp(`\\.kb-panel \\{[^}]*--coach-${name}: (#[0-9a-fA-F]{6})`))![1];
  // .kb-white overrides the roles it needs to; the rest keep the panel's colour
  const onWhite = (name: string) => css.match(new RegExp(`\\.kb-white \\{[^}]*--coach-${name}: (#[0-9a-fA-F]{6})`))?.[1] ?? panel(name);
  for (const name of roles) {
    assert.ok(contrastRatio(panel(name), black) >= 3, `${name} on a black key: ${contrastRatio(panel(name), black).toFixed(2)}`);
    assert.ok(contrastRatio(onWhite(name), white) >= 3, `${name} on a white key: ${contrastRatio(onWhite(name), white).toFixed(2)}`);
    assert.ok(contrastRatio(panel(name), column) >= 4.5, `${name} as text: ${contrastRatio(panel(name), column).toFixed(2)}`);
  }
  assert.equal(new Set(roles.map(panel)).size, roles.length, 'the four roles are four colours');
});

test('readableOn keeps a colour that passes and lightens one that does not, in the same hue', () => {
  assert.equal(readableOn('#ffffff', '#202020'), '#ffffff');
  const lifted = readableOn('#6366f1', '#202020'); // the indigo track colour
  assert.ok(contrastRatio(lifted, '#202020') >= 4.5);
  assert.ok(contrastRatio('#6366f1', '#202020') < 4.5);
});
