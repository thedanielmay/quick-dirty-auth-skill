import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShape } from '../scripts/detect.mjs';

const fixture = (files) => ({
  readJson: (p) => files[p] ? JSON.parse(files[p]) : null,
  readText: (p) => files[p] ?? null,
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

test('detects fastify via dependency', () => {
  const fs = fixture({ 'package.json': JSON.stringify({ dependencies: { fastify: '4' } }) });
  assert.equal(detectShape(fs).shape, 'fastify');
});

test('fastify in devDependencies is detected too', () => {
  const fs = fixture({ 'package.json': JSON.stringify({ devDependencies: { fastify: '4' } }) });
  assert.equal(detectShape(fs).shape, 'fastify');
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

// --- sibling 2: a static signal outranks a stray server file ---

test('a static build config outranks a stray server.js', () => {
  const fs = fixture({
    'index.html': '<html></html>',
    'server.js': 'console.log("left over");',
    'vercel.json': JSON.stringify({ outputDirectory: 'dist', buildCommand: 'npm run build' }),
  });
  assert.equal(detectShape(fs).shape, 'static');
});

test('a Next export outranks a stray server file', () => {
  const fs = fixture({
    'server.js': 'console.log("left over");',
    'next.config.js': 'module.exports = { output: "export" };',
  });
  assert.equal(detectShape(fs).shape, 'static');
});

test('conflicting server dependency and static export report unknown', () => {
  const fs = fixture({
    'package.json': JSON.stringify({ dependencies: { express: '4' } }),
    'next.config.mjs': 'export default { output: "export" };',
  });
  assert.equal(detectShape(fs).shape, 'unknown');
  assert.match(detectShape(fs).reason, /conflict/);
});
