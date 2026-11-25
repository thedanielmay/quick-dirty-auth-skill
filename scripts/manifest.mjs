const SECRET_KEYS = new Set(['password', 'credential']);

// A password never reaches disk. Keep only the flag that says one is set.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      out[key] = stripSecrets(val);
    }
    return out;
  }
  return value;
}

export function emptyManifest(fields = {}) {
  return stripSecrets({
    version: 1, route: null, url: null, passwordSet: false, resources: [], ...fields,
  });
}
export function addResource(manifest, resource) {
  return { ...manifest, resources: [...manifest.resources, stripSecrets(resource)] };
}
export function mergeManifest(manifest, fields) {
  return { ...stripSecrets(manifest), ...stripSecrets(fields), resources: manifest.resources };
}
export function markPasswordSet(manifest) {
  return { ...stripSecrets(manifest), passwordSet: true };
}

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function loadManifest(root) {
  const p = join(root, '.qda.json');
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const hadPassword = Object.keys(raw).some((key) => SECRET_KEYS.has(key.toLowerCase()));
  const cleaned = { ...stripSecrets(raw), passwordSet: Boolean(raw.passwordSet || hadPassword) };
  if (hadPassword) saveManifest(root, cleaned);
  return cleaned;
}
export function saveManifest(root, manifest) {
  writeFileSync(join(root, '.qda.json'), JSON.stringify(stripSecrets(manifest), null, 2) + '\n');
}

export function ensureIgnoreEntries(root, io = {}) {
  const { exists = existsSync, read = readFileSync, write = writeFileSync } = io;
  const added = [];
  for (const name of ['.gitignore', '.vercelignore']) {
    const path = join(root, name);
    const current = exists(path) ? read(path, 'utf8') : '';
    if (current.split(/\r?\n/).some((line) => line.trim() === '.qda.json')) continue;
    const next = current && !current.endsWith('\n')
      ? `${current}\n.qda.json\n`
      : `${current}.qda.json\n`;
    write(path, next);
    added.push(name);
  }
  return added;
}

// CLI: node manifest.mjs <read|password-set|ignore> <root>
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , command, root] = process.argv;
  if (!command || !root) {
    console.error('usage: node manifest.mjs <read|password-set|ignore> <root>');
    process.exitCode = 1;
  } else if (command === 'read') {
    const manifest = loadManifest(root);
    console.log(manifest ? JSON.stringify(manifest) : 'no manifest');
  } else if (command === 'password-set') {
    const current = loadManifest(root) ?? emptyManifest();
    saveManifest(root, markPasswordSet(current));
    console.log('passwordSet: true');
  } else if (command === 'ignore') {
    const added = ensureIgnoreEntries(root);
    console.log(added.length ? `added .qda.json to ${added.join(', ')}` : 'ignore files already exclude .qda.json');
  } else {
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
  }
}
