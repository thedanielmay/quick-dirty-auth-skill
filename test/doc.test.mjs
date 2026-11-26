import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { recordResource, saveManifest, loadManifest, emptyManifest } from '../scripts/manifest.mjs';
import { teardownGate } from '../scripts/gate-apply.mjs';
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
test('release metadata is 1.3.0', () => {
  assert.equal(plugin.version, '1.3.0');
  assert.equal(pkg.version, '1.3.0');
  assert.match(skill, /^  version: "1\.3\.0"$/m);
});

test('the 1.3.0 changelog heading is first', () => {
  assert.match(changelog.slice(changelog.indexOf('\n## ')), /^\n## 1\.3\.0 - 2026-11-26\n/);
});

test('the 1.2.0 changelog section describes new behaviour only', () => {
  assert.match(changelog, /^## 1\.2\.0 - 2026-11-26$/m);
  const section = changelog.split('## 1.2.0 - 2026-11-26')[1].split('\n## ')[0];
  assert.ok(section.split('\n').filter((l) => l.startsWith('- ')).length >= 5);
  assert.doesNotMatch(section, /1\.0\.3/);
  assert.doesNotMatch(section, /redeploy|apply the gate again|remove old deployments/i);
});

test('the 1.1.0 changelog section is retained', () => {
  assert.match(changelog, /^## 1\.1\.0 - 2026-11-26$/m);
  const section = changelog.split('## 1.1.0 - 2026-11-26')[1].split('\n## ')[0];
  assert.ok(section.split('\n').filter((l) => l.startsWith('- ')).length >= 5);
});

test('the Cloudflare route checks the Access JWT at the app', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  for (const needle of [
    'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'Cf-Access-Jwt-Assertion',
    'x-qda-gate: access', 'x-qda-gate: locked', 'RS256', '403', '503',
  ]) {
    assert.match(section, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), needle);
  }
  assert.match(section, /Vercel Standard Protection/i);
  assert.match(section, /password is ignored/i);
  assert.match(section, /gated from the moment/i);
  assert.match(section, /no path is exempt/i);
});

test('the Cloudflare route asks for the host, email list and account choice', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  assert.match(section, /allowed emails/i);
  assert.match(section, /inside the found zone/i);
  assert.match(section, /more than one account/i);
  assert.match(section, /Zero Trust/i);
  assert.match(section, /vercel link/);
  assert.match(section, /preview and production/i);
});

test('the Cloudflare route records IDs, checks the host and tears down recorded IDs', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  assert.match(section, /\.qda\.json/);
  assert.match(section, /connect-to/i);
  assert.match(section, /cloudflareaccess\.com/);
  assert.match(section, /never 200/i);
  assert.match(section, /read back from the policy response/i);
  assert.match(section, /deletes only recorded IDs/i);
  assert.match(section, /Vercel domain/i);
});

test('the changelog only describes the new Cloudflare behaviour', () => {
  const section = changelog.split('## 1.2.0 - 2026-11-26')[1].split('\n## ')[0];
  assert.match(section, /Cloudflare Access/i);
  assert.match(section, /JWT/i);
  assert.match(section, /CNAME/i);
});

test('a DNS record is recorded for teardown only when this skill created it', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  assert.match(section, /only when `created` is true/i);
  assert.match(section, /created: false/i);
  const teardown = skill.split('## Teardown (`--teardown`)')[1].split('\n## ')[0];
  assert.match(teardown, /only records it created/i);
});

test('the preview URL shows the 403 access text rather than the Access sign-in page', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  assert.match(section, /vercel\.app/);
  assert.match(section, /403 access text/i);
  assert.match(section, /not the Access sign-in page/i);
  assert.match(section, /custom host/i);
});

test('the Cloudflare route uses CLI subcommands for its client calls', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  assert.match(section, /cloudflare\.mjs upsert-cname/);
  assert.doesNotMatch(section, /upsertProxiedCname\(/);
});

test('every record shape in the Cloudflare route is accepted and survives gate teardown', () => {
  const section = skill.split('### Cloudflare route')[1].split('\n## ')[0];
  const shapes = [...section.matchAll(/'(\{"kind":[^']+\})'/g)].map((m) => JSON.parse(m[1]));
  assert.ok(shapes.length >= 4, 'app, policy, DNS record and Vercel domain');
  const dir = mkdtempSync(join(tmpdir(), 'qda-doc-'));
  try {
    let manifest = emptyManifest();
    for (const shape of shapes) manifest = recordResource(manifest, shape);
    manifest = recordResource(manifest, shapes[0]);
    saveManifest(dir, manifest);
    teardownGate(dir, loadManifest(dir));
    const byKind = (list) => [...list].sort((x, y) => x.kind.localeCompare(y.kind));
    assert.deepEqual(byKind(loadManifest(dir).resources), byKind(shapes), 'each record once, after a re-run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
