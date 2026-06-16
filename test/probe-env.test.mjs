import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendRoute } from '../scripts/probe-env.mjs';

test('recommends cloudflare when token present and domain on CF', () => {
  const r = recommendRoute({ cfTokenPresent: true, domainOnCloudflare: true, vercelAuthed: true });
  assert.equal(r.route, 'cloudflare');
  assert.match(r.reason, /Cloudflare/);
});

test('recommends password when no CF token', () => {
  assert.equal(recommendRoute({ cfTokenPresent: false, domainOnCloudflare: true }).route, 'password');
});

test('recommends password when domain not on CF even with token', () => {
  assert.equal(recommendRoute({ cfTokenPresent: true, domainOnCloudflare: false }).route, 'password');
});

test('flags when vercel not authed', () => {
  assert.equal(recommendRoute({ vercelAuthed: false }).needsVercelLogin, true);
});
