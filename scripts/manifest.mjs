// Any field named for a password or credential, except the flag that one is set.
const isSecret = (key) => /password|credential/i.test(key) && key !== 'passwordSet';

// A password never reaches disk. Keep only the flag that says one is set.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSecret(key)) continue;
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

import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const ifPresent = (read) => {
  try { return read(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// A symbolic link can send a read or a write to a file outside the project.
export function refuseLink(root, path) {
  const name = relative(root, path);
  if (ifPresent(() => lstatSync(path))?.isSymbolicLink()) {
    throw new Error(`Refusing to use ${name}: it is a symbolic link`);
  }
  const base = ifPresent(() => realpathSync(root));
  const folder = ifPresent(() => realpathSync(dirname(path)));
  if (base && folder && (relative(base, folder) === '..' || relative(base, folder).startsWith(`..${sep}`))) {
    throw new Error(`Refusing to use ${name}: its folder is outside the project root`);
  }
}

// A file record names its file, and any backup, as text.
const wellFormed = (r) => Boolean(r) && typeof r === 'object' && (r.kind !== 'file'
  || (typeof r.path === 'string' && (r.backup === undefined || typeof r.backup === 'string')));

export function loadManifest(root) {
  const p = join(root, '.qda.json');
  refuseLink(root, p);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const records = raw?.resources ?? [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(records) || !records.every(wellFormed)) {
    throw new Error('.qda.json is damaged: it needs a list of records');
  }
  const stripped = stripSecrets(raw);
  const hadValue = Object.entries(raw).some(([key, value]) => isSecret(key) && value);
  const cleaned = { ...stripped, resources: stripped.resources ?? [], passwordSet: Boolean(raw.passwordSet || hadValue) };
  // Rewrite the file when any secret field, at any depth, was removed.
  if (JSON.stringify(stripped) !== JSON.stringify(raw)) saveManifest(root, cleaned);
  return cleaned;
}
export function saveManifest(root, manifest) {
  refuseLink(root, join(root, '.qda.json'));
  writeFileSync(join(root, '.qda.json'), JSON.stringify(stripSecrets(manifest), null, 2) + '\n');
}

export function ensureIgnoreEntries(root, io = {}) {
  const { exists = existsSync, read = readFileSync, write = writeFileSync } = io;
  const added = [];
  const names = ['.gitignore', '.vercelignore'];
  for (const name of names) refuseLink(root, join(root, name));
  for (const name of names) {
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

// A record for an outside resource, such as a Cloudflare id. gate-apply.mjs writes the file records.
export function recordResource(manifest, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.kind !== 'string' || !record.kind || record.kind === 'file'
      || typeof record.id !== 'string' || !record.id) {
    throw new Error('a record needs a text kind other than "file" and a text id');
  }
  // A re-run records the same id once.
  const others = manifest.resources.filter((r) => !(r.kind === record.kind && r.id === record.id));
  return addResource({ ...manifest, resources: others }, record);
}
// Drop a record after its resource is deleted. File records belong to gate-apply.mjs teardown.
export function forgetResource(manifest, kind, id) {
  if (!kind || !id) throw new Error('forget needs a kind and an id');
  if (kind === 'file') throw new Error('gate-apply.mjs teardown removes file records');
  return { ...manifest, resources: manifest.resources.filter((r) => !(r.kind === kind && r.id === id)) };
}

// CLI: node manifest.mjs <read|password-set|ignore> <root>
//      node manifest.mjs record <root> '<json>'   and   node manifest.mjs forget <root> <kind> <id>
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , command, root, ...rest] = process.argv;
  if (!command || !root) {
    console.error("usage: node manifest.mjs <read|password-set|ignore> <root> | record <root> '<json>' | forget <root> <kind> <id>");
    process.exitCode = 1;
  } else if (command === 'record') {
    const current = loadManifest(root) ?? emptyManifest();
    saveManifest(root, recordResource(current, JSON.parse(rest[0] ?? 'null')));
    console.log(`recorded: ${rest[0]}`);
  } else if (command === 'forget') {
    const current = loadManifest(root) ?? emptyManifest();
    const next = forgetResource(current, rest[0], rest[1]);
    saveManifest(root, next);
    console.log(`forgot ${current.resources.length - next.resources.length} record(s)`);
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
