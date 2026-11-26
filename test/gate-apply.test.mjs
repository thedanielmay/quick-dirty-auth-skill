import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planGate, applyGate, isQdaGate, teardownGate, verifyMounted,
} from '../scripts/gate-apply.mjs';

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

test('applyGate reads the template and writes it to the target dest', () => {
  const writes = [];
  const mockWriter = (path, contents) => writes.push({ path, contents });
  const plan = applyGate('next', '/tmp/some-target', mockWriter);
  assert.equal(writes.length, 1);
  assert.equal(plan.dest, 'middleware.ts');
  assert.match(writes[0].path, /\/tmp\/some-target\/middleware\.ts$/);
  // the real next template content should have been read from ../templates
  assert.match(writes[0].contents, /qda_auth/);
  assert.match(writes[0].contents, /GATE_PASSWORD/);
});

test('static plan declares an ensureFiles package.json', () => {
  const p = planGate('static');
  assert.ok(Array.isArray(p.ensureFiles));
  assert.equal(p.ensureFiles[0].dest, 'package.json');
});

test('applyGate(static) writes middleware + package.json when package.json is absent', () => {
  const writes = [];
  const mockWriter = (path, contents) => writes.push({ path, contents });
  const noneExist = () => false;
  const plan = applyGate('static', '/tmp/static-target', mockWriter, noneExist);
  const paths = writes.map((w) => w.path);
  assert.ok(paths.some((p) => /\/middleware\.ts$/.test(p)));
  assert.ok(paths.some((p) => /\/package\.json$/.test(p)));
  assert.deepEqual(plan.ensuredWritten, ['package.json']);
});

test('applyGate(static) does NOT clobber an existing package.json', () => {
  const writes = [];
  const mockWriter = (path, contents) => writes.push({ path, contents });
  const pkgExists = (path) => /package\.json$/.test(path); // pretend package.json already there
  const plan = applyGate('static', '/tmp/static-target', mockWriter, pkgExists);
  const paths = writes.map((w) => w.path);
  assert.ok(paths.some((p) => /\/middleware\.ts$/.test(p)));        // middleware still written
  assert.ok(!paths.some((p) => /\/package\.json$/.test(p)));         // package.json NOT written
  assert.deepEqual(plan.ensuredWritten, []);
});

// --- c9: no silent overwrite, backup on force, teardown restores only our files ---

test('isQdaGate recognises a gate this skill wrote', () => {
  assert.equal(isQdaGate('// qda-gate: quick-dirty-auth\nconst x = 1;'), true);
  assert.equal(isQdaGate('const express = require("express");'), false);
});

test('applyGate refuses to overwrite a file that is not a qda gate', () => {
  const writes = [];
  const writer = (path, contents) => writes.push({ path, contents });
  const exists = (path) => /qda-gate\.js$/.test(path);
  const read = () => 'const app = require("express")();\napp.get("/", handler);';
  assert.throws(
    () => applyGate('node-server', '/app', writer, exists, { read }),
    /Refusing to overwrite.*qda-gate\.js.*--force/,
  );
  assert.equal(writes.length, 0, 'nothing may be written before the user agrees');
});

test('applyGate replaces an older or edited gate without force and keeps a copy', () => {
  const writes = [];
  const writer = (path, contents) => writes.push({ path, contents });
  const exists = (path) => /qda-gate\.js$/.test(path);
  const read = () => '// qda-gate: quick-dirty-auth\nconst old = true;';
  const plan = applyGate('node-server', '/app', writer, exists, { read });
  assert.equal(writes.length, 2);
  assert.deepEqual(plan.created, []);
  assert.deepEqual(plan.overwritten, ['qda-gate.js']);
  assert.deepEqual(plan.backups, []);
  assert.deepEqual(plan.copies, ['qda-gate.js.qda-backup']);

  const again = [];
  const current = writes[1].contents;
  applyGate('node-server', '/app', (path) => again.push(path), exists, { read: () => current });
  assert.equal(again.length, 1, 'an unchanged gate needs no copy');
});

test('applyGate with force saves a backup next to the file before overwriting', () => {
  const writes = [];
  const writer = (path, contents) => writes.push({ path, contents });
  const exists = (path) => /qda-gate\.js$/.test(path);
  const read = () => 'const mine = "keep this";';
  const plan = applyGate('node-server', '/app', writer, exists, { read, force: true });
  const backup = writes.find((w) => /qda-gate\.js\.qda-backup$/.test(w.path));
  assert.ok(backup, 'a backup must be written');
  assert.equal(backup.contents, 'const mine = "keep this";');
  assert.deepEqual(plan.backups, ['qda-gate.js.qda-backup']);
  assert.deepEqual(plan.overwritten, ['qda-gate.js']);
});

const gateContent = '// qda-gate: quick-dirty-auth\nconst old = true;';

test('teardownGate deletes only files the skill created', () => {
  const removed = [];
  const saved = [];
  const manifest = {
    version: 1, resources: [
      { kind: 'file', path: 'middleware.ts', created: true },
      { kind: 'dns', id: 'rec1' },
    ],
  };
  const result = teardownGate('/app', manifest, {
    exists: (p) => p === '/app/middleware.ts',
    read: () => gateContent,
    remove: (p) => removed.push(p),
    saveManifest: (m) => saved.push(m),
  });
  assert.deepEqual(removed, ['/app/middleware.ts']);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(saved[0].resources, [{ kind: 'dns', id: 'rec1' }]);
});

test('teardownGate restores a backup and leaves the backup file removed', () => {
  const writes = [];
  const removed = [];
  const exists = (p) => /\.qda-backup$/.test(p);
  const read = () => 'const mine = "keep this";';
  const manifest = {
    version: 1, resources: [{ kind: 'file', path: 'qda-gate.js', backup: 'qda-gate.js.qda-backup' }],
  };
  const result = teardownGate('/app', manifest, {
    exists, read, write: (p, c) => writes.push({ path: p, contents: c }), remove: (p) => removed.push(p),
    saveManifest: () => {},
  });
  assert.deepEqual(writes, [{ path: '/app/qda-gate.js', contents: 'const mine = "keep this";' }]);
  assert.ok(removed.some((p) => /\.qda-backup$/.test(p)));
  assert.deepEqual(result.restored, ['qda-gate.js']);
});

test('teardownGate removes an ensured file only while its content still matches', () => {
  const original = '{"name":"qda-static-app","private":true,"version":"0.0.0"}';
  const resource = { kind: 'file', path: 'package.json', created: true, exactContent: original };
  const unchanged = [];
  teardownGate('/app', { resources: [resource] }, {
    exists: () => true,
    read: () => original,
    remove: (p) => unchanged.push(p),
    saveManifest: () => {},
  });
  assert.deepEqual(unchanged, ['/app/package.json']);

  const changed = [];
  teardownGate('/app', { resources: [resource] }, {
    exists: () => true,
    read: () => '{"name":"mine"}',
    remove: (p) => changed.push(p),
    saveManifest: () => {},
  });
  assert.deepEqual(changed, []);
});

// --- fault 4: teardown is narrow, repeatable and path-safe ---

test('teardownGate leaves a created file the user replaced with their own content', () => {
  const removed = [];
  const result = teardownGate('/app', {
    resources: [{ kind: 'file', path: 'qda-gate.js', created: true }],
  }, {
    exists: () => true,
    read: () => 'const mine = "keep this";',
    remove: (p) => removed.push(p),
    saveManifest: () => {},
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(result.removed, []);
});

test('teardownGate skips a missing created file without crashing', () => {
  const removed = [];
  assert.doesNotThrow(() => teardownGate('/app', {
    resources: [{ kind: 'file', path: 'qda-gate.js', created: true }],
  }, {
    exists: () => false,
    remove: (p) => removed.push(p),
    saveManifest: () => {},
  }));
  assert.deepEqual(removed, []);
});

test('teardownGate rejects a resource path outside the project root', () => {
  for (const path of ['../secret.txt', '/etc/passwd', 'nested/../../secret.txt']) {
    assert.throws(
      () => teardownGate('/app', { resources: [{ kind: 'file', path, created: true }] }, {
        exists: () => true,
        read: () => gateContent,
        remove: () => {},
        saveManifest: () => {},
      }),
      /outside the project root/,
      path,
    );
  }
});

test('a second and third teardown do nothing', () => {
  const saved = [];
  const manifest = { resources: [{ kind: 'file', path: 'qda-gate.js', created: true }] };
  const io = {
    exists: () => true,
    read: () => gateContent,
    remove: () => {},
    saveManifest: (m) => saved.push(m),
  };
  assert.equal(teardownGate('/app', manifest, io).removed.length, 1);
  assert.equal(teardownGate('/app', saved[0], io).removed.length, 0);
  assert.equal(teardownGate('/app', saved[saved.length - 1], io).removed.length, 0);
});

// --- sibling 1: gate must be mounted before routes ---

const vfs = (files) => ({
  exists: (p) => p in files,
  read: (p) => files[p] ?? '',
  readJson: (p) => (files[p] ? JSON.parse(files[p]) : null),
});

test('verifyMounted accepts an Express gate mounted before routes', () => {
  const io = vfs({ 'package.json': '{"main":"server.js"}', 'server.js': `
    const gate = require('./qda-gate');
    const app = require('express')();
    app.use(gate);
    app.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'node-server', io).mounted, true);
});

test('verifyMounted rejects a gate mounted after routes', () => {
  const io = vfs({ 'server.js': `const gate = require('./qda-gate'); const app = require('express')(); app.get('/', handler); app.use(gate);` });
  const result = verifyMounted('/app', 'node-server', io);
  assert.equal(result.mounted, false);
  assert.match(result.reason, /before routes/);
});

test('verifyMounted rejects a missing mount and a missing entry file', () => {
  assert.equal(verifyMounted('/app', 'node-server', vfs({ 'server.js': 'app.listen(3000);' })).mounted, false);
  assert.equal(verifyMounted('/app', 'node-server', vfs({})).mounted, false);
});

test('verifyMounted accepts a Fastify onRequest hook', () => {
  const io = vfs({ 'server.js': `
    const fastify = require('fastify')();
    fastify.addHook('onRequest', require('./qda-gate'));
    fastify.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'fastify', io).mounted, true);
});

test('verifyMounted passes for framework-mounted gates', () => {
  assert.equal(verifyMounted('/app', 'static', vfs({})).mounted, true);
  assert.equal(verifyMounted('/app', 'next', vfs({})).mounted, true);
});

// --- fault 1: the gate mount must be the first app call, whatever the argument ---

for (const before of [
  "app.use(express.static('public'));",
  "app.use(require('./routes'));",
  'app.use(apiRouter);',
  "app.get('/health', handler);",
  'app.register(routes);',
]) {
  test(`verifyMounted rejects an app call before the gate: ${before}`, () => {
    const io = vfs({ 'server.js': `
      const gate = require('./qda-gate');
      const app = require('express')();
      ${before}
      app.use(gate);
      app.get('/', handler);
    ` });
    assert.equal(verifyMounted('/app', 'node-server', io).mounted, false);
  });
}

test('verifyMounted rejects a Fastify register before the onRequest hook', () => {
  const io = vfs({ 'server.js': `
    const fastify = require('fastify')();
    const gate = require('./qda-gate');
    fastify.register(routes);
    fastify.addHook('onRequest', gate);
    fastify.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'fastify', io).mounted, false);
});

test('verifyMounted accepts a gate with no routes at all', () => {
  const io = vfs({ 'server.js': `
    const gate = require('./qda-gate');
    const app = require('express')();
    app.use(gate);
    app.listen(3000);
  ` });
  assert.equal(verifyMounted('/app', 'node-server', io).mounted, true);
});

// --- fault 2: comments do not count, strings are left alone, object must match ---

test('verifyMounted ignores line and block comments before the gate', () => {
  const io = vfs({ 'server.js': `
    // app.get('/old', handler);
    /* app.use(express.static('public')); */
    const gate = require('./qda-gate');
    const app = require('express')();
    app.use(gate);
    app.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'node-server', io).mounted, true);
});

test('verifyMounted does not strip a URL inside a string', () => {
  const io = vfs({ 'server.js': `
    const url = 'http://x/y';
    const gate = require('./qda-gate');
    const app = require('express')();
    app.use(gate);
    app.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'node-server', io).mounted, true);
});

test('verifyMounted rejects a commented out Fastify hook', () => {
  const io = vfs({ 'server.js': `
    const fastify = require('fastify')();
    const gate = require('./qda-gate');
    // fastify.addHook('onRequest', gate);
    fastify.get('/', handler);
  ` });
  assert.equal(verifyMounted('/app', 'fastify', io).mounted, false);
});

test('verifyMounted rejects a gate on a router when routes are on the app', () => {
  const io = vfs({ 'server.js': `
    const gate = require('./qda-gate');
    const app = express();
    const router = express.Router();
    router.use(gate);
    app.get('/', handler);
  ` });
  const result = verifyMounted('/app', 'node-server', io);
  assert.equal(result.mounted, false);
  assert.match(result.reason, /directly after the app/);
});

const head = "const gate = require('./qda-gate');\nconst app = require('express')();\n";
for (const [name, source, expected, shape = 'node-server'] of [
  ['routes added by a function call before the gate', head + "require('./routes')(app);\napp.use(gate);", false],
  ['a helper that receives the app before the gate', head + "registerRoutes(app);\napp.use(gate);", false],
  ['a mount written inside a string', head + "const s = 'app.use(gate)';\napp.get('/', h);", false],
  ['a Fastify hook inside a string', "const gate = require('./qda-gate');\nconst app = require('fastify')();\nconst s = \"app.addHook('onRequest', gate)\";", false, 'fastify'],
  ['a chained call on the creation line', "const gate = require('./qda-gate');\nconst app = require('express')().get('/', h);\napp.use(gate);", false],
  ['a chained call on the mount line', head + "app.use(gate)\n  .get('/', h);", false],
  ['a name that is not the gate', "const gate = require('./other');\nconst app = require('express')();\napp.use(gate);", false],
  ['a second app', head + "app.use(gate);\nconst admin = require('express')();", false],
  ['a router used after the gate', "import express from 'express';\nimport gate from './qda-gate.js';\nconst app = express();\napp.use(gate);\nconst router = express.Router();\nconst port = getPort();\napp.use(router);", true],
  ['a typed app with options', "const Fastify = require('fastify');\nconst app = Fastify({ logger: true });\nconst gate = require('./qda-gate');\napp.addHook('onRequest', gate);\napp.register(routes);", true, 'fastify'],
  ['an inline require mount', "const app = require('express')();\napp.use(require('./qda-gate'));", true],
]) {
  test(`verifyMounted strict rule: ${name}`, () => {
    const result = verifyMounted('/app', shape, vfs({ 'server.js': source }));
    assert.equal(result.mounted, expected, result.reason);
  });
}

const ok = "const gate = require('./qda-gate');\nconst app = require('express')();\napp.use(gate);\n";
const open = "const app = require('express')();\napp.get('/', h);\n";
for (const [name, files, expected] of [
  ['an ungated app.js beside a gated server.js', { 'server.js': ok, 'app.js': open }, false],
  ['a gated app.js with another main', { 'package.json': '{"main":"index.js"}', 'app.js': ok }, true],
  ['a gated src/index.ts', { 'src/index.ts': ok }, true],
  ['the file named by the start script', { 'package.json': '{"scripts":{"start":"node boot/web.js"}}', 'boot/web.js': open, 'server.js': ok }, false],
  ['a regex with a quote before the app', { 'server.js': "const t = s.replace(/'/g, '');\n" + ok }, true],
  ['a regex that would hide an early route', { 'server.js': "const gate = require('./qda-gate');\nconst a = /'/;\nconst app = require('express')();\napp.get('/a', h);\nconst b = 'app.use(gate)';" }, false],
  ['a division is not a regex', { 'server.js': "const n = total / 2; const m = n / 4;\n" + ok }, true],
  ['a second plain server', { 'server.js': ok + "require('http').createServer((q, r) => r.end('x')).listen(4000);" }, false],
  ['a server wrapped around the gated app', { 'server.js': ok + "require('http').createServer(app).listen(3000);" }, true],
  ['a gate name that can change', { 'server.js': "let gate = require('./qda-gate');\nconst app = require('express')();\napp.use(gate);\ngate = (q, r, n) => n();" }, false],
]) {
  test(`verifyMounted entry rule: ${name}`, () => {
    const result = verifyMounted('/app', 'node-server', vfs(files));
    assert.equal(result.mounted, expected, result.reason);
  });
}
