const MAP = {
  next:          { template: 'next-middleware.ts', dest: 'middleware.ts', mountInstruction: null },
  // static also needs a package.json so vercel can resolve the edge middleware;
  // ensureFiles are written only if absent (never clobber an existing file).
  static:        { template: 'edge-middleware.ts', dest: 'middleware.ts', mountInstruction: null,
                   ensureFiles: [{ template: 'static-package.json', dest: 'package.json' }] },
  'node-server': { template: 'express-gate.js',   dest: 'qda-gate.js',
                   mountInstruction: "Add near the top of your server, before routes: const gate = require('./qda-gate'); app.use(gate);" },
};

export function planGate(shape) {
  if (shape === 'unknown') throw new Error('Cannot apply gate to unknown shape — disambiguate first.');
  const plan = MAP[shape];
  if (!plan) throw new Error(`Unknown shape: ${shape}`);
  return plan;
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const readTemplate = (name) => readFileSync(join(here, '..', 'templates', name), 'utf8');

export function applyGate(shape, targetRoot, writer = writeFileSync, exists = existsSync) {
  const plan = planGate(shape);
  writer(join(targetRoot, plan.dest), readTemplate(plan.template));
  // Write any ensureFiles that don't already exist (don't clobber the user's files).
  const wrote = [];
  for (const f of plan.ensureFiles ?? []) {
    const path = join(targetRoot, f.dest);
    if (!exists(path)) { writer(path, readTemplate(f.template)); wrote.push(f.dest); }
  }
  return { ...plan, ensuredWritten: wrote };
}

// CLI: node gate-apply.mjs <shape> <targetRoot>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , shape, target] = process.argv;
  const plan = applyGate(shape, target);
  console.log(`applied ${plan.template} -> ${plan.dest}`);
  if (plan.mountInstruction) console.log(plan.mountInstruction);
}
