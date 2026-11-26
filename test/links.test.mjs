import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGate, teardownGate } from '../scripts/gate-apply.mjs';
import { saveManifest, ensureIgnoreEntries, emptyManifest } from '../scripts/manifest.mjs';

const TMP = await mkdtemp(join(tmpdir(), 'qda-links-'));
after(() => rm(TMP, { recursive: true, force: true }));

let seq = 0;
// A project folder next to an outside file that must never change.
async function project() {
  const base = join(TMP, String(seq++));
  const root = join(base, 'project');
  await mkdir(root, { recursive: true });
  const outside = join(base, 'outside.txt');
  await writeFile(outside, 'keep');
  return { base, root, outside };
}

test('applyGate refuses a linked destination, ensured file or record file', async () => {
  for (const [shape, name] of [['node-server', 'qda-gate.js'], ['static', 'package.json'], ['node-server', '.qda.json']]) {
    const { root, outside } = await project();
    await symlink(outside, join(root, name));
    assert.throws(() => applyGate(shape, root, undefined, undefined, { force: true }), /symbolic link/, name);
    assert.equal(await readFile(outside, 'utf8'), 'keep');
    assert.equal(existsSync(join(root, 'middleware.ts')), false);
  }
});

test('applyGate refuses a dangling link at the backup name', async () => {
  const { base, root } = await project();
  await writeFile(join(root, 'qda-gate.js'), 'mine');
  await symlink(join(base, 'new.txt'), join(root, 'qda-gate.js.qda-backup'));
  assert.throws(() => applyGate('node-server', root, undefined, undefined, { force: true }), /symbolic link/);
  assert.equal(existsSync(join(base, 'new.txt')), false);
});

test('teardownGate refuses a linked target or a linked folder, and changes nothing', async () => {
  const { base, root, outside } = await project();
  await writeFile(join(root, 'saved'), 'restored text');
  await symlink(outside, join(root, 'qda-gate.js'));
  await symlink(base, join(root, 'folder'));
  for (const path of ['qda-gate.js', 'folder/outside.txt']) {
    assert.throws(() => teardownGate(root, { resources: [{ kind: 'file', path, backup: 'saved' }] }), /Refusing to use/, path);
  }
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  assert.equal(existsSync(join(root, 'saved')), true);
});

test('the record file and ignore files are not written through a link', async () => {
  const { root, outside } = await project();
  await symlink(outside, join(root, '.qda.json'));
  assert.throws(() => saveManifest(root, emptyManifest()), /symbolic link/);
  await symlink(outside, join(root, '.vercelignore'));
  assert.throws(() => ensureIgnoreEntries(root), /symbolic link/);
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});
