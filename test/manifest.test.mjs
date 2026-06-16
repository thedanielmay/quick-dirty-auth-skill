import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyManifest, addResource, mergeManifest } from '../scripts/manifest.mjs';

test('emptyManifest has expected shape', () => {
  const m = emptyManifest({ route: 'password', url: null });
  assert.equal(m.route, 'password');
  assert.deepEqual(m.resources, []);
  assert.equal(m.version, 1);
});

test('addResource appends without mutating input', () => {
  const m = emptyManifest({ route: 'password' });
  const m2 = addResource(m, { kind: 'file', path: 'middleware.ts' });
  assert.equal(m.resources.length, 0);          // original untouched
  assert.equal(m2.resources.length, 1);
  assert.equal(m2.resources[0].kind, 'file');
});

test('mergeManifest overlays top-level fields and concatenates resources', () => {
  const a = addResource(emptyManifest({ route: 'cloudflare' }), { kind: 'dns', id: 'x' });
  const b = mergeManifest(a, { url: 'https://app1.example.com' });
  assert.equal(b.url, 'https://app1.example.com');
  assert.equal(b.route, 'cloudflare');
  assert.equal(b.resources.length, 1);
});
