import { readFileSync, writeFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { loadManifest, saveManifest, emptyManifest, addResource, refuseLink } from './manifest.mjs';

const MARKER = 'qda-gate: quick-dirty-auth';
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
                   mountInstruction: "Add near the top of your server, before routes: const gate = require('./qda-gate'); app.addHook('onRequest', gate);" },
};

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
  const backups = [];

  const destPath = join(targetRoot, plan.dest);
  // Check every fixed path before the first write.
  for (const name of [plan.dest, '.qda.json', ...(plan.ensureFiles ?? []).map((f) => f.dest)]) {
    refuseLink(targetRoot, join(targetRoot, name));
  }
  if (exists(destPath)) {
    const previous = read(destPath);
    if (!isQdaGate(previous) && !force) {
      throw new Error(
        `Refusing to overwrite ${plan.dest}: it is not a gate this skill wrote. ` +
        'Ask the user, then re-run with --force to save a backup first.',
      );
    }
    if (!isQdaGate(previous)) {
      let suffix = '';
      let n = 0;
      while (exists(`${destPath}.qda-backup${suffix}`)) suffix = `.${++n}`;
      const backup = `${plan.dest}.qda-backup${suffix}`;
      refuseLink(targetRoot, join(targetRoot, backup));
      writer(`${destPath}.qda-backup${suffix}`, previous);
      backups.push(backup);
    }
    overwritten.push(plan.dest);
  } else {
    created.push(plan.dest);
  }
  writer(destPath, readTemplate(plan.template));

  const ensuredWritten = [];
  for (const f of plan.ensureFiles ?? []) {
    const path = join(targetRoot, f.dest);
    if (!exists(path)) {
      writer(path, readTemplate(f.template));
      ensuredWritten.push(f.dest);
    }
  }
  return { ...plan, created, overwritten, backups, ensuredWritten };
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

export function teardownGate(root, manifest, io = {}) {
  const { remove = unlinkSync,
          exists = existsSync,
          read = (p) => readFileSync(p, 'utf8'),
          write = writeFileSync,
          saveManifest: persist = (m) => saveManifest(root, m) } = io;
  const resources = manifest?.resources ?? [];
  const files = resources.filter((r) => r.kind === 'file');
  for (const resource of files) {
    projectPath(root, resource.path, 'remove');
    if (resource.backup) projectPath(root, resource.backup, 'restore');
  }
  const removed = [];
  const restored = [];
  for (const resource of files) {
    const target = projectPath(root, resource.path, 'remove');
    if (resource.backup) {
      const backup = projectPath(root, resource.backup, 'restore');
      if (exists(backup)) {
        write(target, read(backup));
        remove(backup);
        restored.push(resource.path);
      }
    } else if (resource.created && exists(target)) {
      const content = read(target);
      const stillOurs = resource.exactContent !== undefined
        ? content === resource.exactContent
        : isQdaGate(content);
      if (stillOurs) {
        remove(target);
        removed.push(resource.path);
      }
    }
  }
  if (manifest) persist({ ...manifest, resources: [] });
  return { removed, restored };
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
  if (servers.some((m) => !usesApp.test(m[1])) || /\bnew\s+(?:Koa|Hono|Elysia)\b/.test(bare)) {
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

export function verifyMounted(root, shape, io = {}) {
  if (shape === 'next' || shape === 'static') {
    return { mounted: true, reason: 'the framework loads middleware.ts automatically', entry: null };
  }
  const { exists = (p) => existsSync(join(root, p)),
          read = (p) => readFileSync(join(root, p), 'utf8') } = io;
  const readJson = io.readJson ?? ((p) => { try { return JSON.parse(read(p)); } catch { return null; } });
  const pkg = exists('package.json') ? readJson('package.json') : null;
  const started = /(?<![\w-])(?:node|nodemon|tsx|ts-node)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./-]+\.[cm]?[jt]s)\b/
    .exec(pkg?.scripts?.start ?? '')?.[1];
  const named = ['server', 'index', 'app'].flatMap((n) => ['js', 'mjs', 'cjs', 'ts'].map((x) => `${n}.${x}`));
  const entries = [...new Set([
    ...[pkg?.main, started].filter((f) => typeof f === 'string').map((f) => f.replace(/^\.\//, '')),
    ...named, ...named.map((f) => `src/${f}`), 'api/index.js', 'api/index.ts',
  ])];

  // Every candidate file that creates an app must pass, and at least one must exist.
  let passed = null;
  for (const entry of entries) {
    if (!exists(entry)) continue;
    const result = checkEntry(read(entry), shape);
    if (!result) continue;
    if (!result.mounted) return { ...result, entry };
    passed ??= { ...result, entry };
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
    if (!result.mounted) process.exitCode = 1;
  } else if (command === 'teardown') {
    const result = teardownGate(args[1], loadManifest(args[1]));
    console.log(`removed: ${result.removed.join(', ') || 'none'}; restored: ${result.restored.join(', ') || 'none'}`);
  } else {
    const shape = command === 'apply' ? args[1] : command;
    const root = command === 'apply' ? args[2] : args[1];
    if (!shape || !root) {
      console.error('usage: node gate-apply.mjs <apply <shape> <root> [--force]|verify <shape> <root>|teardown <root>>');
      process.exitCode = 1;
    } else {
      const plan = applyGate(shape, root, writeFileSync, existsSync, { force });
      let manifest = loadManifest(root) ?? emptyManifest();
      for (const path of plan.created) manifest = addResource(manifest, { kind: 'file', path, created: true });
      for (const path of plan.ensuredWritten) {
        const template = plan.ensureFiles.find((f) => f.dest === path)?.template;
        manifest = addResource(manifest, {
          kind: 'file', path, created: true, exactContent: readTemplate(template),
        });
      }
      for (const path of plan.overwritten) {
        // An overwritten gate this skill wrote is already recorded. Only a
        // backed-up user file needs a new record so teardown can restore it.
        const backup = plan.backups.find((b) => b.startsWith(`${path}.qda-backup`));
        if (backup) manifest = addResource(manifest, { kind: 'file', path, backup });
      }
      saveManifest(root, manifest);
      console.log(`applied ${plan.template} -> ${plan.dest}`);
      if (plan.backups.length) console.log(`backups: ${plan.backups.join(', ')}`);
      if (plan.mountInstruction) console.log(plan.mountInstruction);
      if (shape === 'node-server' || shape === 'fastify') {
        const result = verifyMounted(root, shape);
        console.log(`mounted: ${result.mounted} (${result.reason})`);
        if (!result.mounted) process.exitCode = 1;
      }
    }
  }
}
