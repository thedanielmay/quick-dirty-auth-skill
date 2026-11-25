import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyManifest, addResource, mergeManifest, loadManifest, saveManifest,
  markPasswordSet, ensureIgnoreEntries,
} from '../scripts/manifest.mjs';

test('emptyManifest has expected shape', () => {
  const m = emptyManifest({ route: 'password', url: null });
  assert.equal(m.route, 'password');
  assert.deepEqual(m.resources, []);
  assert.equal(m.version, 1);
  assert.equal(m.passwordSet, false);
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

const tempRoot = () => mkdtempSync(join(tmpdir(), 'qda-manifest-'));

test('saveManifest never writes a password or credential to disk', () => {
  const root = tempRoot();
  try {
    saveManifest(root, {
      ...emptyManifest({ route: 'password' }),
      password: 'hunter2',
      credential: 'hunter2',
    });
    const raw = readFileSync(join(root, '.qda.json'), 'utf8');
    assert.doesNotMatch(raw, /hunter2/);
    const saved = JSON.parse(raw);
    assert.equal(saved.password, undefined);
    assert.equal(saved.credential, undefined);
    assert.equal(saved.passwordSet, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadManifest removes any password field from an older manifest', () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, '.qda.json'), JSON.stringify({
      version: 1, route: 'password', credential: 'old-secret', password: 'old-secret',
    }));
    const loaded = loadManifest(root);
    assert.equal(loaded.credential, undefined);
    assert.equal(loaded.password, undefined);
    assert.equal(loaded.passwordSet, true, 'an old credential implies a password was set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadManifest saves a cleaned manifest at once when it removes a password', () => {
  const root = tempRoot();
  try {
    const dirty = JSON.stringify({
      version: 1, route: 'password', credential: 'old-secret', resources: [{ kind: 'dns', id: 'x' }],
    });
    writeFileSync(join(root, '.qda.json'), dirty);
    const loaded = loadManifest(root);
    const raw = readFileSync(join(root, '.qda.json'), 'utf8');
    assert.doesNotMatch(raw, /old-secret/);
    assert.equal(loaded.passwordSet, true);
    assert.equal(JSON.parse(raw).passwordSet, true);
    assert.equal(JSON.parse(raw).credential, undefined);
    assert.equal(JSON.parse(raw).resources.length, 1, 'other manifest fields survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markPasswordSet records a flag and no value', () => {
  const m = markPasswordSet(emptyManifest({ route: 'password', password: 'hunter2' }));
  assert.equal(m.passwordSet, true);
  assert.equal(m.password, undefined);
  assert.equal(m.credential, undefined);
});

test('ensureIgnoreEntries creates both ignore files with a .qda.json line', () => {
  const root = tempRoot();
  try {
    const added = ensureIgnoreEntries(root);
    assert.deepEqual(added, ['.gitignore', '.vercelignore']);
    for (const name of ['.gitignore', '.vercelignore']) {
      assert.equal(readFileSync(join(root, name), 'utf8'), '.qda.json\n');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureIgnoreEntries appends once and never duplicates a line', () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.qda.json\n');
    writeFileSync(join(root, '.vercelignore'), 'temp');
    assert.deepEqual(ensureIgnoreEntries(root), ['.vercelignore']);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.qda.json\n');
    assert.equal(readFileSync(join(root, '.vercelignore'), 'utf8'), 'temp\n.qda.json\n');
    assert.deepEqual(ensureIgnoreEntries(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
