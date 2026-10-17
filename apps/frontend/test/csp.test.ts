// The built app's Content-Security-Policy (#157)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSP, PROVIDER_HOST } from '../csp.ts';

test('the CSP allows scripts from this origin only, and connections to this origin, the provider and GhostDAW', () => {
  const directive = (name: string) => CSP.split('; ').find((d) => d.startsWith(`${name} `))!.split(' ').slice(1);
  assert.deepEqual(directive('script-src'), ["'self'"]);
  assert.deepEqual(directive('connect-src'), ["'self'", PROVIDER_HOST, 'ws://localhost:*', 'ws://127.0.0.1:*']);
  assert.equal(new URL(PROVIDER_HOST).host, 'generativelanguage.googleapis.com');
  assert.deepEqual(directive('object-src'), ["'none'"]);
});
