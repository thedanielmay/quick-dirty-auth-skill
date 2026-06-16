import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGate } from '../scripts/gate-apply.mjs';

test('next maps to middleware.ts', () => {
  const p = planGate('next');
  assert.equal(p.template, 'next-middleware.ts');
  assert.equal(p.dest, 'middleware.ts');
  assert.equal(p.mountInstruction, null);
});

test('static maps to edge middleware', () => {
  assert.equal(planGate('static').template, 'edge-middleware.ts');
  assert.equal(planGate('static').dest, 'middleware.ts');
});

test('node-server maps to qda-gate.js with a mount instruction', () => {
  const p = planGate('node-server');
  assert.equal(p.dest, 'qda-gate.js');
  assert.match(p.mountInstruction, /app\.use/);
});

test('unknown throws', () => {
  assert.throws(() => planGate('unknown'), /disambiguate/);
});
