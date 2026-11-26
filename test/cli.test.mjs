import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const run = (script, ...args) =>
  execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8' }).trim();

const tempRoot = () => mkdtempSync(join(tmpdir(), 'qda-cli-'));

test('SKILL.md lists the scripts that run with node', () => {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
  const section = skill.split('## Scripts')[1].split('## Run flow')[0];
  const listed = [...section.matchAll(/`([a-z-]+\.mjs)`/g)].map((m) => m[1]);
  assert.deepEqual(listed, [
    'detect.mjs', 'probe-env.mjs', 'gate-apply.mjs',
    'cloudflare.mjs', 'manifest.mjs', 'password.mjs',
  ]);
});

test('detect.mjs prints the detected shape', () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    assert.match(run('detect.mjs', dir), /^static:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe-env.mjs prints the recommended route without running vercel', () => {
  assert.match(run('probe-env.mjs', '--cf', '--domain-on-cf', '--vercel-authed'), /^cloudflare:/);
  assert.match(run('probe-env.mjs'), /^password:/);
});

test('gate-apply.mjs keeps a reapplied gate removable at teardown', () => {
  const dir = tempRoot();
  try {
    run('gate-apply.mjs', 'apply', 'static', dir);
    run('gate-apply.mjs', 'apply', 'static', dir);
    assert.match(run('gate-apply.mjs', 'teardown', dir), /^removed: middleware\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-apply.mjs prints the applied template and verifies the mount', () => {
  const dir = tempRoot();
  try {
    assert.match(run('gate-apply.mjs', 'apply', 'static', dir), /^applied edge-middleware\.ts -> middleware\.ts/);
    assert.match(run('gate-apply.mjs', 'verify', 'static', dir), /^mounted: true/);
    assert.match(run('gate-apply.mjs', 'teardown', dir), /^removed: middleware\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest.mjs prints a useful result for ignore and password-set', () => {
  const dir = tempRoot();
  try {
    assert.match(run('manifest.mjs', 'ignore', dir), /\.qda\.json/);
    assert.match(run('manifest.mjs', 'password-set', dir), /^passwordSet: true/);
    assert.match(run('manifest.mjs', 'read', dir), /"passwordSet":true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('password.mjs prints a usable password', () => {
  const password = run('password.mjs');
  assert.equal(password.length, 24);
  assert.match(password, /^[A-Za-z0-9_-]+$/);
});

// Fault 5: the CLI records the ensured package.json and only removes its own copy.
test('gate-apply records the static package.json and teardown removes it when unchanged', () => {
  const dir = tempRoot();
  try {
    run('gate-apply.mjs', 'apply', 'static', dir);
    const manifest = JSON.parse(readFileSync(join(dir, '.qda.json'), 'utf8'));
    const pkg = manifest.resources.find((r) => r.path === 'package.json');
    assert.ok(pkg, 'package.json must be recorded');
    assert.equal(pkg.created, true);
    assert.ok(pkg.exactContent, 'the exact written content must be recorded');
    assert.match(run('gate-apply.mjs', 'teardown', dir), /removed: middleware\.ts, package\.json/);
    assert.equal(existsSync(join(dir, 'middleware.ts')), false);
    assert.equal(existsSync(join(dir, 'package.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('teardown leaves a package.json the user changed after the static gate was applied', () => {
  const dir = tempRoot();
  try {
    run('gate-apply.mjs', 'apply', 'static', dir);
    writeFileSync(join(dir, 'package.json'), '{"name":"my-app"}');
    const result = run('gate-apply.mjs', 'teardown', dir);
    assert.match(result, /removed: middleware\.ts/);
    assert.doesNotMatch(result.split('\n')[0], /package\.json/);
    assert.match(result, /kept[^\n]*package\.json/);
    assert.equal(existsSync(join(dir, 'package.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fault 3: every CLI must run through a symlink and a path with a space.
test('each CLI runs from a folder with a space and through a symlink', () => {
  const spaced = mkdtempSync(join(tmpdir(), 'qda space '));
  const plain = mkdtempSync(join(tmpdir(), 'qda-cli-'));
  const appRoot = tempRoot();
  writeFileSync(join(appRoot, 'index.html'), '<html></html>');
  const cases = [
    ['detect.mjs', [appRoot], /^static:/],
    ['probe-env.mjs', [], /^password:/],
    ['password.mjs', [], /^[A-Za-z0-9_-]{24}$/],
    ['manifest.mjs', ['ignore', appRoot], /\.qda\.json/],
    ['gate-apply.mjs', ['apply', 'static', appRoot], /^applied /],
  ];
  const runThrough = (dir, link, args) =>
    execFileSync(process.execPath, [join(dir, link), ...args], { encoding: 'utf8', cwd: dir }).trim();
  try {
    for (const [script, args, pattern] of cases) {
      const spacedLink = script;
      const plainLink = `my ${script}`;
      symlinkSync(join(root, 'scripts', script), join(spaced, spacedLink));
      symlinkSync(join(root, 'scripts', script), join(plain, plainLink));
      assert.match(runThrough(spaced, spacedLink, args), pattern, `${script} via folder with a space`);
      assert.match(runThrough(plain, plainLink, args), pattern, `${script} via symlink with a space`);
    }
  } finally {
    rmSync(spaced, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
    rmSync(appRoot, { recursive: true, force: true });
  }
});
