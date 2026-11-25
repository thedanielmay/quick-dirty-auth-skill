import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

// Low 1: the preview check follows a redirect, like the production check.
test('the preview check follows a redirect before judging headers', () => {
  const preview = skill.split('3. Check the preview.')[1].split('4. Promote:')[0];
  assert.match(preview, /3xx/, 'preview check must name the redirect status');
  assert.match(preview, /location/, 'preview check must name the location header');
  assert.match(preview, /both checks/, 'both header checks must run on the redirect target');
});

test('the skill says a host health check sees 503 until the password is set', () => {
  assert.match(skill, /health check/i);
  assert.match(skill, /503 until/i);
  assert.match(skill, /no path is exempt/i);
});

test('the skill never records the password and excludes .qda.json from deploys', () => {
  assert.match(skill, /Never record the password/i);
  assert.match(skill, /password-set flag/i);
  assert.match(skill, /\.gitignore/);
  assert.match(skill, /\.vercelignore/);
});

test('the skill verifies the gate is mounted before deploy and relies on x-qda-gate', () => {
  assert.match(skill, /gate-apply\.mjs verify/);
  assert.match(skill, /before routes/);
  assert.match(skill, /x-qda-gate/);
});

test('the skill covers the Fastify hook gate and backup restore on teardown', () => {
  assert.match(skill, /fastify/i);
  assert.match(skill, /addHook/);
  assert.match(skill, /--force/);
  assert.match(skill, /restore any backup/i);
});

test('the 1.0.3 section covers a committed manifest and a leaked password', () => {
  const section = skill.split('## Already published with 1.0.3 or earlier')[1].split('\n## ')[0];
  assert.match(section, /git rm --cached \.qda\.json/);
  assert.match(section, /password is in the git history/i);
  assert.match(section, /change the password/i);
});

test('prose uses no em dash or en dash', () => {
  assert.doesNotMatch(skill, /—|–/);
  assert.doesNotMatch(changelog, /—|–/);
});

// Low 3: the minimum Node version is declared.
test('package.json declares Node 22.18 or newer', () => {
  assert.equal(pkg.engines?.node, '>=22.18');
});

// Release metadata.
test('release metadata is 1.1.0', () => {
  assert.equal(plugin.version, '1.1.0');
  assert.match(skill, /^  version: "1\.1\.0"$/m);
});

test('the 1.1.0 changelog heading is first and describes new behaviour only', () => {
  assert.match(changelog, /^## 1\.1\.0 - 2026-11-26$/m);
  const section = changelog.split('## 1.1.0 - 2026-11-26')[1].split('\n## ')[0];
  assert.ok(section.split('\n').filter((l) => l.startsWith('- ')).length >= 5);
  assert.doesNotMatch(section, /1\.0\.3/);
  assert.doesNotMatch(section, /redeploy|apply the gate again|remove old deployments/i);
});
