// verify refuses layouts where a part of the site can answer without the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { verifyMounted, applyGate, teardownGate } from '../scripts/gate-apply.mjs';

const gated = "const gate = require('./qda-gate');\nconst app = require('express')();\napp.use(gate);\n";
const ungated = "const app = require('express')();\napp.get('/', h);\n";
const nextGate = '// qda-gate: quick-dirty-auth\n';

// A real folder, so the default file access is tested too.
function project(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'qda-verify-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const verify = (shape, files) => project(files, (root) => verifyMounted(root, shape));

test('an Express project with a file in public/ is refused', () => {
  const result = verify('node-server', { 'server.js': gated, 'public/logo.png': 'x' });
  assert.equal(result.mounted, false);
  assert.match(result.reason, /public\//);
});

test('an Express project with a file deep in public/ is refused', () => {
  assert.equal(verify('node-server', { 'server.js': gated, 'public/a/b/data.json': '{}' }).mounted, false);
});

test('an Express project with an empty public/ folder tree passes', () => {
  const result = project({ 'server.js': gated }, (root) => {
    mkdirSync(join(root, 'public', 'empty'), { recursive: true });
    return verifyMounted(root, 'node-server');
  });
  assert.equal(result.mounted, true, result.reason);
});

test('a Next.js project with a public/ folder still passes', () => {
  const result = verify('next', { 'middleware.ts': nextGate, 'public/logo.png': 'x', 'app/page.tsx': 'x' });
  assert.equal(result.mounted, true, result.reason);
});

for (const name of ['api/report.py', 'api/report.go', 'api/deep/report.rb']) {
  for (const shape of ['node-server', 'fastify']) {
    test(`${shape}: ${name} is refused`, () => {
      const server = shape === 'fastify' ? "const app = require('fastify')();\napp.addHook('onRequest', require('./qda-gate'));\n" : gated;
      const result = verify(shape, { 'server.js': server, [name]: 'x' });
      assert.equal(result.mounted, false);
      assert.equal(result.entry, name);
    });
  }
}

test('placeholder files in public/ do not block', () => {
  const result = verify('node-server', { 'server.js': gated, 'public/.DS_Store': 'x', 'public/img/.gitkeep': '' });
  assert.equal(result.mounted, true, result.reason);
});

test('an api file with an upper case ending is refused', () => {
  assert.equal(verify('node-server', { 'server.js': gated, 'api/report.PY': 'x' }).mounted, false);
});

test('a data file under api/ does not block', () => {
  const result = verify('node-server', { 'server.js': gated, 'api/data.json': '{}' });
  assert.equal(result.mounted, true, result.reason);
});

test('a start script that names a file with no extension is checked', () => {
  const result = verify('node-server', {
    'package.json': '{"scripts":{"start":"node lib/real"}}', 'lib/real.js': ungated, 'server.js': gated,
  });
  assert.equal(result.mounted, false);
  assert.equal(result.entry, 'lib/real.js');
});

test('a gated file named without an extension does not block a gated server.js', () => {
  const result = verify('node-server', {
    'package.json': '{"scripts":{"start":"node --enable-source-maps boot"}}', 'boot.js': gated, 'server.js': gated,
  });
  assert.equal(result.mounted, true, result.reason);
});

// The extra start file checks only refuse. A pass needs one of the usual entry files.
test('a file named without an extension does not give a pass on its own', () => {
  const result = verify('node-server', { 'package.json': '{"scripts":{"start":"node boot"}}', 'boot.js': gated });
  assert.equal(result.mounted, false);
});

for (const [start, files, entry] of [
  ['node boot', { boot: ungated, 'boot.js': gated }, 'boot'],
  ['node lib', { 'lib/package.json': '{"main":"real.js"}', 'lib/real.js': ungated, 'lib/index.js': gated }, 'lib/real.js'],
  ['node migrate.js && node real', { 'migrate.js': '1;', 'real.js': ungated }, 'real.js'],
  ['node -r dotenv/config real', { 'real.js': ungated }, 'real.js'],
  ['node "real"', { 'real.js': ungated }, 'real.js'],
  ['tsx watch real', { 'real.ts': ungated }, 'real.ts'],
  ['pm2 start lib/real.js', { 'lib/real.js': ungated }, 'lib/real.js'],
  ['node .', { 'boot.js': ungated }, 'boot.js'],
]) {
  test(`an ungated file behind "${start}" is refused`, () => {
    const pkg = { scripts: { start }, ...(start === 'node .' ? { main: 'boot' } : {}) };
    const result = verify('node-server', { 'package.json': JSON.stringify(pkg), 'server.js': gated, ...files });
    assert.equal(result.mounted, false);
    assert.equal(result.entry, entry);
  });
}

for (const name of ['app.mts', 'index.cts', 'src/server.mts']) {
  test(`an ungated ${name} beside a gated server.js is refused`, () => {
    const result = verify('node-server', { 'server.js': gated, [name]: ungated });
    assert.equal(result.mounted, false);
    assert.equal(result.entry, name);
  });
}

test('teardown reports the ignore files that still list the record file', () => {
  const result = project({ '.gitignore': 'node_modules\n.qda.json\n', '.vercelignore': 'dist\n' }, (root) => {
    applyGate('node-server', root);
    return teardownGate(root, { version: 1, resources: [] });
  });
  assert.deepEqual(result.ignoreLines, ['.gitignore']);
});

test('only ./qda-gate counts as the gate, not a package of the same name', () => {
  const result = verify('node-server', { 'server.js': gated.replace('./qda-gate', 'qda-gate') });
  assert.equal(result.mounted, false);
});

for (const start of ['node --import tsx boot/web.ts', 'node --loader ts-node boot/web.ts', 'node -r dotenv/config boot/web.js']) {
  test(`the start file is checked in: ${start}`, () => {
    const file = start.split(' ').pop();
    const result = verify('node-server', {
      'package.json': JSON.stringify({ scripts: { start } }), [file]: ungated, 'server.js': gated,
    });
    assert.equal(result.mounted, false);
    assert.equal(result.entry, file);
  });
}
