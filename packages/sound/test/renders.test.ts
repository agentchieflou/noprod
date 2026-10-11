// Every library sound renders exactly as it did when its fingerprint was
// taken (#108: the engine grew coupled strings and parallel radiators, and
// a sound that has neither must not change by a bit)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIBRARY } from '../src/library/index.ts';
import { FILE, fingerprint } from './renders.ts';

test('library sounds render bit for bit as fingerprinted', () => {
  const prints: Record<string, string> = JSON.parse(readFileSync(FILE, 'utf8'));
  const changed = LIBRARY.filter((r) => prints[r.id] && fingerprint(r) !== prints[r.id]).map((r) => r.id);
  assert.deepEqual(changed, [], `these render differently (if on purpose: node test/renders.ts --write): ${changed.join(', ')}`);
  assert.ok(Object.keys(prints).length >= 129);
});
