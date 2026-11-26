import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { teardownGate, verifyMounted } from '../scripts/gate-apply.mjs';
import { emptyManifest, loadManifest } from '../scripts/manifest.mjs';

const TMP = await mkdtemp(join(tmpdir(), 'qda-records-'));
after(() => rm(TMP, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../scripts/gate-apply.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });

let seq = 0;
async function project(files = {}) {
  const root = join(TMP, String(seq++));
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}
const text = (root, name) => readFile(join(root, name), 'utf8');
const MARK = '// qda-gate: quick-dirty-auth\n';

test('teardown refuses a record for a file the skill does not write, and changes nothing', async () => {
  const root = await project({ '.git/config': 'mine', 'payload.txt': 'other', 'qda-gate.js': MARK });
  for (const record of [
    { path: '.git/config', backup: 'payload.txt' },
    { path: 'payload.txt', created: true },
    { path: 'qda-gate.js', backup: 'payload.txt' },
  ]) {
    const records = [{ kind: 'file', path: 'qda-gate.js', created: true }, { kind: 'file', ...record }];
    assert.throws(() => teardownGate(root, { resources: records }), /Refusing to/, record.path);
  }
  assert.equal(await text(root, '.git/config'), 'mine');
  assert.equal(await text(root, 'payload.txt'), 'other');
  assert.equal(existsSync(join(root, 'qda-gate.js')), true);
});

test('teardown keeps edits made after apply, with the backup and its record', async () => {
  const root = await project({ 'middleware.ts': 'user v1' });
  run('apply', 'static', root, '--force');
  await writeFile(join(root, 'middleware.ts'), 'user v2');
  assert.match(run('teardown', root), /kept, because/);
  assert.equal(await text(root, 'middleware.ts'), 'user v2');
  assert.equal(await text(root, 'middleware.ts.qda-backup'), 'user v1');
  assert.equal(loadManifest(root).resources.filter((r) => r.path === 'middleware.ts').length, 1);
});

test('an edited gate is copied on apply, and apply then teardown removes the gate', async () => {
  const root = await project();
  run('apply', 'static', root);
  const gate = await text(root, 'middleware.ts');
  await writeFile(join(root, 'middleware.ts'), `${gate}// my change`);
  assert.match(run('apply', 'static', root), /kept a copy/);
  assert.equal(await text(root, 'middleware.ts.qda-backup'), `${gate}// my change`);
  assert.match(run('teardown', root), /^removed: middleware\.ts/);
});

test('a damaged record file stops apply before any write', async () => {
  const root = await project({ '.qda.json': '{bad', 'middleware.ts': 'mine' });
  assert.throws(() => run('apply', 'static', root, '--force'));
  assert.equal(await text(root, 'middleware.ts'), 'mine');
  assert.equal(existsSync(join(root, 'middleware.ts.qda-backup')), false);
});

test('other password field names stay off disk, and an empty one does not set the flag', async () => {
  assert.deepEqual(Object.keys(emptyManifest({ GATE_PASSWORD: 'x', gatePassword: 'x' })).filter((k) => /password/i.test(k)), ['passwordSet']);
  const root = await project({ '.qda.json': '{"version":1,"credential":null,"resources":[]}' });
  assert.equal(loadManifest(root).passwordSet, false);
  assert.doesNotMatch(await text(root, '.qda.json'), /credential/);
});

const SERVER = "const gate = require('./qda-gate');\nconst app = require('express')();\napp.use(gate);\n";

test('the mount check fails when another route can answer without the gate', async () => {
  const cases = [
    { 'server.js': SERVER, 'api/secret.js': 'module.exports = (q, r) => r.end("data");' },
    { 'server.js': `${SERVER}const http = require('http');\nnew http.Server(handler).listen(1);` },
    { 'server.js': SERVER, 'package.json': '{"type":"module"}' },
  ];
  for (const files of cases) assert.equal(verifyMounted(await project(files), 'node-server').mounted, false, Object.keys(files).join());
  const handOn = await project({ 'server.js': SERVER, 'api/index.js': "module.exports = require('../server');\n" });
  assert.equal(verifyMounted(handOn, 'node-server').mounted, true);
});

test('a Next project with pages in src needs the gate in src', async () => {
  const root = await project({ 'src/app/page.tsx': 'x', 'middleware.ts': MARK });
  assert.equal(verifyMounted(root, 'next').mounted, false);
  await writeFile(join(root, 'src', 'middleware.ts'), MARK);
  assert.equal(verifyMounted(root, 'next').mounted, true);
});
