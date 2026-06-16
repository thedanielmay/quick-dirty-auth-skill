import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShape } from '../scripts/detect.mjs';

const fixture = (files) => ({
  readJson: (p) => files[p] ? JSON.parse(files[p]) : null,
  exists: (p) => p in files,
});

test('detects Next.js via dependency', () => {
  const fs = fixture({ 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }) });
  assert.equal(detectShape(fs).shape, 'next');
});

test('detects node-server via express', () => {
  const fs = fixture({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }) });
  assert.equal(detectShape(fs).shape, 'node-server');
});

test('detects node-server via server.js', () => {
  const fs = fixture({ 'server.js': '' });
  assert.equal(detectShape(fs).shape, 'node-server');
});

test('detects static via index.html with no server', () => {
  const fs = fixture({ 'index.html': '<html></html>' });
  assert.equal(detectShape(fs).shape, 'static');
});

test('returns unknown when nothing matches', () => {
  const fs = fixture({ 'README.md': '' });
  assert.equal(detectShape(fs).shape, 'unknown');
});

test('next wins over a stray index.html', () => {
  const fs = fixture({
    'package.json': JSON.stringify({ dependencies: { next: '15' } }),
    'public/index.html': '',
  });
  assert.equal(detectShape(fs).shape, 'next');
});
