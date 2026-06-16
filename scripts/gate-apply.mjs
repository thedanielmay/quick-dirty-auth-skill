const MAP = {
  next:          { template: 'next-middleware.ts', dest: 'middleware.ts', mountInstruction: null },
  static:        { template: 'edge-middleware.ts', dest: 'middleware.ts', mountInstruction: null },
  'node-server': { template: 'express-gate.js',   dest: 'qda-gate.js',
                   mountInstruction: "Add near the top of your server, before routes: const gate = require('./qda-gate'); app.use(gate);" },
};

export function planGate(shape) {
  if (shape === 'unknown') throw new Error('Cannot apply gate to unknown shape — disambiguate first.');
  const plan = MAP[shape];
  if (!plan) throw new Error(`Unknown shape: ${shape}`);
  return plan;
}

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export function applyGate(shape, targetRoot, writer = writeFileSync) {
  const plan = planGate(shape);
  const tpl = readFileSync(join(here, '..', 'templates', plan.template), 'utf8');
  writer(join(targetRoot, plan.dest), tpl);
  return plan;
}
