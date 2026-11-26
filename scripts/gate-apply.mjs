import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, sep, posix } from 'node:path';
import { loadManifest, saveManifest, emptyManifest, addResource, refuseLink } from './manifest.mjs';

const MARKER = 'qda-gate: quick-dirty-auth';
// Found in the package.json this skill adds to a static project.
const STATIC_PACKAGE = '"qda-static-app"';
const here = dirname(fileURLToPath(import.meta.url));
const readTemplate = (name) => readFileSync(join(here, '..', 'templates', name), 'utf8');

const MAP = {
  next:          { template: 'next-middleware.ts', dest: 'middleware.ts', mountInstruction: null },
  // static also needs a package.json so vercel can resolve the edge middleware;
  // ensureFiles are written only if absent (never clobber an existing file).
  static:        { template: 'edge-middleware.ts', dest: 'middleware.ts', mountInstruction: null,
                   ensureFiles: [{ template: 'static-package.json', dest: 'package.json' }] },
  'node-server': { template: 'express-gate.js',   dest: 'qda-gate.js',
                   mountInstruction: "Add on the lines directly after the app is created, before anything else: const gate = require('./qda-gate'); app.use(gate);" },
  fastify:       { template: 'fastify-gate.js',   dest: 'qda-gate.js',
                   mountInstruction: "Add on the lines directly after the app is created, before anything else: const gate = require('./qda-gate'); app.addHook('onRequest', gate);" },
};

// The only files this skill writes, so the only files teardown can touch.
const SRC_GATE = 'src/middleware.ts';
const GATE_FILES = new Set([SRC_GATE,
  ...Object.values(MAP).flatMap((p) => [p.dest, ...(p.ensureFiles ?? []).map((f) => f.dest)])]);

// Next.js reads the root app/ or pages/ folder first. It uses src/ only without them.
const usesSrc = (exists) => !(exists('app') || exists('pages')) && (exists('src/app') || exists('src/pages'));

export function planGate(shape) {
  if (shape === 'unknown') throw new Error('Cannot apply gate to unknown shape; disambiguate first.');
  const plan = MAP[shape];
  if (!plan) throw new Error(`Unknown shape: ${shape}`);
  return plan;
}

export function isQdaGate(content) {
  return String(content ?? '').includes(MARKER);
}

export function applyGate(shape, targetRoot, writer = writeFileSync, exists = existsSync, opts = {}) {
  const { read = (p) => readFileSync(p, 'utf8'), force = false } = opts;
  const plan = planGate(shape);
  const created = [];
  const overwritten = [];
  const backups = []; // a user file, restored at teardown
  const copies = [];  // an older or edited gate, kept for the user
  const template = readTemplate(plan.template);
  const dest = shape === 'next' && usesSrc((p) => exists(join(targetRoot, p))) ? SRC_GATE : plan.dest;

  const destPath = join(targetRoot, dest);
  // Check every fixed path before the first write.
  for (const name of [dest, '.qda.json', ...(plan.ensureFiles ?? []).map((f) => f.dest)]) {
    refuseLink(targetRoot, join(targetRoot, name));
  }
  if (exists(destPath)) {
    const previous = read(destPath);
    if (!isQdaGate(previous) && !force) {
      throw new Error(
        `Refusing to overwrite ${dest}: it is not a gate this skill wrote. ` +
        'Ask the user, then re-run with --force to save a backup first.',
      );
    }
    if (previous !== template) {
      let suffix = '';
      let n = 0;
      while (exists(`${destPath}.qda-backup${suffix}`)) suffix = `.${++n}`;
      const backup = `${dest}.qda-backup${suffix}`;
      refuseLink(targetRoot, join(targetRoot, backup));
      writer(`${destPath}.qda-backup${suffix}`, previous);
      (isQdaGate(previous) ? copies : backups).push(backup);
    }
    overwritten.push(dest);
  } else {
    created.push(dest);
  }
  writer(destPath, template);

  const ensuredWritten = [];
  for (const f of plan.ensureFiles ?? []) {
    const path = join(targetRoot, f.dest);
    if (!exists(path)) {
      writer(path, readTemplate(f.template));
      ensuredWritten.push(f.dest);
    }
  }
  return { ...plan, dest, created, overwritten, backups, copies, ensuredWritten };
}

function projectPath(root, name, action) {
  const base = resolve(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to ${action} ${name}: path resolves outside the project root`);
  }
  refuseLink(base, target);
  return target;
}

// The record file sits in the project, so every record is checked before use.
function checkRecord(root, { path, backup }) {
  projectPath(root, path, 'remove');
  if (backup) projectPath(root, backup, 'restore');
  if (!GATE_FILES.has(path)) throw new Error(`Refusing to touch ${path}: this skill does not write that file`);
  const prefix = `${path}.qda-backup`;
  if (backup && !(backup.startsWith(prefix) && /^(\.\d+)?$/.test(backup.slice(prefix.length)))) {
    throw new Error(`Refusing to restore from ${backup}: it is not a backup of ${path}`);
  }
}

// True while the file is still the one this skill wrote.
function stillOurs(content, { path, exactContent }) {
  const marked = path === 'package.json' ? content.includes(STATIC_PACKAGE) : isQdaGate(content);
  return marked && (exactContent === undefined || content === exactContent);
}

export function teardownGate(root, manifest, io = {}) {
  const { remove = unlinkSync,
          exists = existsSync,
          read = (p) => readFileSync(p, 'utf8'),
          write = writeFileSync,
          saveManifest: persist = (m) => saveManifest(root, m) } = io;
  const resources = manifest?.resources ?? [];
  const files = resources.filter((r) => r.kind === 'file');
  for (const resource of files) checkRecord(root, resource);
  // Other records, such as Cloudflare ids, are not undone here, so they stay.
  const remaining = resources.filter((r) => r.kind !== 'file');
  const removed = [];
  const restored = [];
  const kept = [];
  for (const resource of files) {
    const target = projectPath(root, resource.path, 'remove');
    const present = exists(target);
    const ours = present && stillOurs(read(target), resource);
    if (resource.backup) {
      const backup = projectPath(root, resource.backup, 'restore');
      if (exists(backup) && (!present || ours)) {
        write(target, read(backup));
        remove(backup);
        restored.push(resource.path);
      } else if (present) {
        kept.push(resource.path);
        remaining.push(resource);
      }
    } else if (resource.created && present) {
      if (ours) {
        remove(target);
        removed.push(resource.path);
      } else {
        kept.push(resource.path);
        remaining.push(resource);
      }
    }
  }
  // Report the ignore files that still list the record file; teardown leaves them alone.
  const ignoreLines = ['.gitignore', '.vercelignore'].filter((name) => {
    const path = join(root, name);
    if (!exists(path)) return false;
    try {
      return String(read(path)).split(/\r?\n/).some((line) => line.trim() === '.qda.json');
    } catch {
      return false;
    }
  });
  if (manifest) persist({ ...manifest, resources: remaining });
  return { removed, restored, kept, ignoreLines };
}

// One record per file. A later apply updates it.
function upsertFile(manifest, path, fields) {
  const at = manifest.resources.findIndex((r) => r.kind === 'file' && r.path === path);
  if (at === -1) {
    return addResource(manifest, { kind: 'file', path, ...(fields.backup ? {} : { created: true }), ...fields });
  }
  const resources = [...manifest.resources];
  resources[at] = { ...resources[at], ...fields };
  if (fields.backup) delete resources[at].created;
  return { ...manifest, resources };
}

// A slash starts a regular expression when no value comes before it.
function startsRegex(code, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(code[k])) k -= 1;
  if (k < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(code[k])) return true;
  return /(?<![\w$.])(return|typeof|case|throw|yield|await)$/.test(code.slice(Math.max(0, k - 8), k + 1).join(''));
}

// Two same length views of the source. `code` has comments blanked. `bare` also
// has string contents blanked, so text inside a string never looks like code.
function maskSource(src) {
  const code = src.split('');
  const bare = src.split('');
  const blank = (arr, k) => { if (arr[k] !== '\n') arr[k] = ' '; };
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { blank(bare, i); blank(bare, i + 1); i += 1; continue; }
      if (c === quote) quote = null; else blank(bare, i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && startsRegex(code, i)) {
      let inClass = false;
      let k = i + 1;
      for (; k < src.length && src[k] !== '\n'; k += 1) {
        if (src[k] === '\\') { blank(bare, k); blank(bare, k + 1); k += 1; continue; }
        if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) break;
        blank(bare, k);
      }
      i = k;
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + (src[i + 1] === '/' ? 0 : 2);
      for (let k = i; k < stop; k += 1) { blank(code, k); blank(bare, k); }
      i = stop - 1;
    }
  }
  return { code: code.join(''), bare: bare.join('') };
}

const GATE_PATH = String.raw`['"]\.\/qda-gate(?:\.js)?['"]`;
const FACTORY = /(?<![\w.$])(?:express|fastify|Fastify|require\s*\(\s*['"](?:express|fastify)['"]\s*\))\s*\(/g;

// Offset just past the parenthesis that closes the one at `open`, or -1.
function closeParen(bare, open) {
  let depth = 0;
  for (let i = open; i < bare.length; i += 1) {
    if (bare[i] === '(') depth += 1;
    else if (bare[i] === ')') { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

// One strict rule: the statement directly after the app is created mounts the gate.
// Only the statement that loads the gate may sit between them. Anything else is
// "cannot confirm", because code before the gate runs without the password.
function checkEntry(source, shape) {
  const fail = (reason) => ({ mounted: false, reason });
  const { code, bare } = maskSource(source);
  const apps = [...code.matchAll(FACTORY)].filter((m) => bare[m.index] === code[m.index]);
  if (apps.length === 0) return null;
  if (apps.length > 1) return fail('more than one app is created, so the check cannot confirm the gate');
  const call = apps[0];
  const head = /(?:^|[;\n{}])\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w$.<>[\] ]+?)?\s*=\s*(?:await\s+)?$/
    .exec(code.slice(0, call.index));
  if (!head) return fail('the app must be created as: const app = express() or fastify()');
  const app = head[1].replace(/\$/g, '\\$');
  // Another server in the same file can answer requests without the gate.
  const servers = [...bare.matchAll(/(?<![\w$])createServer\s*\(([^)]*)\)/g)];
  const usesApp = new RegExp(`(?:^|,)\\s*${app}(?:\\.server)?\\s*$`);
  if (servers.some((m) => !usesApp.test(m[1])) || /\bnew\s+(?:Koa|Hono|Elysia)\b/.test(bare)
      || /(?<![\w$])https?\s*\.\s*Server\s*\(/.test(bare)) {
    return fail('another server is created in this file, so the check cannot confirm the gate');
  }
  const end = closeParen(bare, call.index + call[0].length - 1);
  if (end === -1) return fail('the line that creates the app could not be read');

  const binding = new RegExp(
    `const\\s+([\\w$]+)\\s*=\\s*require\\s*\\(\\s*${GATE_PATH}\\s*\\)|import\\s+([\\w$]+)\\s+from\\s+${GATE_PATH}`, 'g');
  const names = [...code.matchAll(binding)]
    .filter((m) => bare[m.index] === code[m.index]).map((m) => m[1] ?? m[2]);
  const gates = [`require\\s*\\(\\s*${GATE_PATH}\\s*\\)`,
    ...names.map((n) => n.replace(/\$/g, '\\$'))].join('|');
  const mount = shape === 'fastify'
    ? `${app}\\s*\\.\\s*addHook\\s*\\(\\s*['"]onRequest['"]\\s*,\\s*(?:${gates})\\s*\\)`
    : `${app}\\s*\\.\\s*use\\s*\\(\\s*(?:${gates})\\s*\\)`;
  const loadLine = `(?:(?:const)\\s+[\\w$]+\\s*=\\s*require\\s*\\(\\s*${GATE_PATH}\\s*\\)\\s*;?\\s*)?`;
  const next = new RegExp(`^\\s*;?\\s*${loadLine}${mount}[ \\t]*(?:;|(?=\\r?\\n|$))`).exec(code.slice(end));
  const rest = next ? code.slice(end + next[0].length) : '';
  if (!next || /^\s*[.([,?&|]/.test(rest)) {
    return fail('the gate line must come directly after the app is created, before routes and everything else');
  }
  return { mounted: true, reason: 'the gate is mounted directly after the app is created' };
}

// A file under api/ whose whole content hands on another file of the project:
// require and export, import and export default, or export { default } from.
const RE_EXPORT = new RegExp(String.raw`^\s*(?:['"]use strict['"]\s*;?\s*)?(?:`
  + String.raw`module\.exports\s*=\s*require\s*\(\s*['"](\.[^'"]+)['"]\s*\)`
  + String.raw`|const\s+([\w$]+)\s*=\s*require\s*\(\s*['"](\.[^'"]+)['"]\s*\)\s*;?\s*module\.exports\s*=\s*\2`
  + String.raw`|export\s*\{\s*default\s*\}\s*from\s*['"](\.[^'"]+)['"]`
  + String.raw`|import\s+([\w$]+)\s+from\s*['"](\.[^'"]+)['"]\s*;?\s*export\s+default\s+\5`
  + String.raw`)\s*;?\s*$`);

// The file a relative name loads. Null when another loading rule could pick a different file.
function handOnTarget(base, exists, read) {
  const isFile = (p) => { if (!exists(p)) return false; try { read(p); return true; } catch { return false; } };
  if (/\.[cm]?[jt]s$/.test(base)) return isFile(base) ? base : null;
  if (isFile(base) || [`${base}.json`, `${base}.node`, `${base}/package.json`].some((p) => exists(p))) return null;
  const matches = [`${base}.js`, `${base}.ts`, `${base}/index.js`, `${base}/index.ts`].filter((p) => exists(p));
  return matches.length === 1 ? matches[0] : null;
}

// An api/ file is guarded when it mounts the gate, or hands on a file that does.
function guarded(file, shape, exists, read) {
  const source = read(file);
  const handOn = RE_EXPORT.exec(maskSource(source).code);
  if (!handOn) return Boolean(checkEntry(source, shape)?.mounted);
  const base = posix.join(posix.dirname(file), handOn[1] ?? handOn[3] ?? handOn[4] ?? handOn[6]);
  if (base.startsWith('..')) return false;
  const target = handOnTarget(base, exists, read);
  return Boolean(target && checkEntry(read(target), shape)?.mounted);
}

const listFiles = (folder) => {
  try { return readdirSync(folder, { recursive: true }).map(String); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
};

// Other files the app can start from: every word of the start script and of
// "main", with the usual endings, plus .mts and .cts entry files. A folder's own
// "main" counts too. These files can only cause a refusal. They never give a pass.
function otherStarts(pkg, readJson) {
  const words = [pkg?.main, ...String(pkg?.scripts?.start ?? '').split(/[\s;&|()=<>]+/)]
    .filter((w) => typeof w === 'string')
    .map((w) => w.replace(/["']/g, ''))
    .filter((w) => w && !w.startsWith('-'));
  const folderMains = words.flatMap((w) => {
    const main = readJson(posix.join(w, 'package.json'))?.main;
    return typeof main === 'string' ? [posix.join(w, main)] : [];
  });
  const endings = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'];
  const guesses = [...words, ...folderMains].flatMap((w) =>
    ['', ...endings.map((x) => `.${x}`), '/index.js'].map((end) => posix.normalize(`${w}${end}`)));
  const typed = ['server', 'index', 'app'].flatMap((n) => [n, `src/${n}`])
    .flatMap((n) => [`${n}.mts`, `${n}.cts`]);
  return [...new Set([...guesses, ...typed])];
}

// The text of a file. A folder has no text. Any other read error stops the check.
function readFile(path, read) {
  try { return read(path); } catch (error) {
    if (error.code === 'EISDIR') return '';
    throw error;
  }
}

export function verifyMounted(root, shape, io = {}) {
  const { exists = (p) => existsSync(join(root, p)),
          read = (p) => readFileSync(join(root, p), 'utf8'),
          list = (p) => listFiles(join(root, p)) } = io;
  if (shape === 'next' || shape === 'static') {
    const gate = shape === 'next' && usesSrc(exists) ? SRC_GATE : 'middleware.ts';
    const mounted = exists(gate) && isQdaGate(read(gate));
    const reason = mounted ? `the framework loads ${gate} automatically` : `${gate} is missing or is not the gate`;
    return { mounted, reason, entry: null };
  }
  const readJson = io.readJson ?? ((p) => { try { return JSON.parse(read(p)); } catch { return null; } });
  const pkg = exists('package.json') ? readJson('package.json') : null;
  if (pkg?.type === 'module') {
    return { mounted: false, reason: 'package.json declares ES modules, and qda-gate.js cannot load there', entry: null };
  }
  // A host can serve public/ as static files, so an Express project keeps no files there.
  if (shape === 'node-server') {
    const served = list('public').some((f) => {
      const name = posix.basename(f);
      if (name === '.DS_Store') return false; // the Vercel CLI does not upload it
      const path = `public/${f}`;
      if (!exists(path)) return false;
      try {
        const text = String(read(path));
        // Empty means no bytes other than plain spaces, tabs and line breaks.
        return name !== '.gitkeep' || !/^[ \t\r\n]*$/.test(text);
      } catch (error) { return error.code !== 'EISDIR'; }
    });
    if (served) {
      return { mounted: false, reason: 'public/ holds files that can be served without the gate; serve them through the app from another folder after the gate', entry: null };
    }
  }
  // Vercel runs each file under api/ as its own function, whatever its language.
  const foreign = list('api').find((f) => /\.(?:py|go|rb)$/i.test(f));
  if (foreign) {
    const entry = `api/${foreign}`;
    return { mounted: false, reason: `${entry} can answer without the gate`, entry };
  }
  const started = /(?<![\w-])(?:node|nodemon|tsx|ts-node)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./-]+\.[cm]?[jt]s)\b/
    .exec(pkg?.scripts?.start ?? '')?.[1];
  const named = ['server', 'index', 'app'].flatMap((n) => ['js', 'mjs', 'cjs', 'ts'].map((x) => `${n}.${x}`));
  const entries = [...new Set([
    ...[pkg?.main, started].filter((f) => typeof f === 'string').map((f) => f.replace(/^\.\//, '')),
    ...named, ...named.map((f) => `src/${f}`), 'api/index.js', 'api/index.ts',
  ])];

  // Vercel runs each file under api/ as its own function.
  const functions = list('api').filter((f) => /\.[cm]?[jt]s$/.test(f) && !/\.d\.ts$/.test(f)).map((f) => `api/${f}`);
  const open = functions.find((f) => !guarded(f, shape, exists, read));
  if (open) return { mounted: false, reason: `${open} can answer without the gate`, entry: open };

  // Every candidate file that creates an app must pass, and at least one guarded file must exist.
  let passed = functions.length
    ? { mounted: true, reason: 'the gate is mounted directly after the app is created', entry: functions[0] } : null;
  for (const entry of entries) {
    if (!exists(entry)) continue;
    const result = checkEntry(read(entry), shape);
    if (!result) continue;
    if (!result.mounted) return { ...result, entry };
    passed ??= { ...result, entry };
  }
  for (const entry of otherStarts(pkg, readJson)) {
    if (!exists(entry)) continue;
    const result = checkEntry(readFile(entry, read), shape);
    if (result && !result.mounted) return { ...result, entry };
  }
  return passed ?? { mounted: false, reason: 'no server entry creates an app and mounts ./qda-gate', entry: null };
}

// CLI: node gate-apply.mjs <apply|verify|teardown|shape> ...
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const command = args[0];
  if (command === 'verify') {
    const result = verifyMounted(args[2], args[1]);
    console.log(`mounted: ${result.mounted} (${result.reason})`);
    if (!result.mounted && result.entry) console.log(`file: ${result.entry}`);
    if (!result.mounted) process.exitCode = 1;
  } else if (command === 'teardown') {
    const result = teardownGate(args[1], loadManifest(args[1]));
    console.log(`removed: ${result.removed.join(', ') || 'none'}; restored: ${result.restored.join(', ') || 'none'}`);
    if (result.kept.length) console.log(`kept, because it changed or has no backup: ${result.kept.join(', ')}`);
    if (result.ignoreLines.length) console.log(`the .qda.json line stays in ${result.ignoreLines.join(', ')}`);
  } else {
    const shape = command === 'apply' ? args[1] : command;
    const root = command === 'apply' ? args[2] : args[1];
    if (!shape || !root) {
      console.error('usage: node gate-apply.mjs <apply <shape> <root> [--force]|verify <shape> <root>|teardown <root>>');
      process.exitCode = 1;
    } else {
      // Read the record file first, so a damaged one stops the run before any write.
      let manifest = loadManifest(root) ?? emptyManifest();
      const plan = applyGate(shape, root, writeFileSync, existsSync, { force });
      const gate = readTemplate(plan.template);
      for (const path of plan.created) manifest = upsertFile(manifest, path, { exactContent: gate });
      for (const path of plan.ensuredWritten) {
        const template = plan.ensureFiles.find((f) => f.dest === path)?.template;
        manifest = upsertFile(manifest, path, { exactContent: readTemplate(template) });
      }
      for (const path of plan.overwritten) {
        const backup = plan.backups.find((b) => b.startsWith(`${path}.qda-backup`));
        manifest = upsertFile(manifest, path, { exactContent: gate, ...(backup ? { backup } : {}) });
      }
      saveManifest(root, manifest);
      console.log(`applied ${plan.template} -> ${plan.dest}`);
      if (plan.backups.length) console.log(`backups: ${plan.backups.join(', ')}`);
      if (plan.copies.length) console.log(`kept a copy of the earlier gate: ${plan.copies.join(', ')}`);
      if (plan.mountInstruction) console.log(plan.mountInstruction);
      if (shape !== 'static') {
        const result = verifyMounted(root, shape);
        console.log(`mounted: ${result.mounted} (${result.reason})`);
        if (!result.mounted) process.exitCode = 1;
      }
    }
  }
}
