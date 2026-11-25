import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// Every case gets a fresh file name so the module is evaluated in isolation.
// The gates read GATE_PASSWORD on each request, not at load time.
const TMP = await mkdtemp(join(tmpdir(), 'qda-gate-behaviour-'));
after(() => rm(TMP, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
let seq = 0;

async function loadFresh(templateFile, password, ext, transform = (s) => s) {
  const src = await readFile(new URL('../templates/' + templateFile, import.meta.url), 'utf8');
  const file = join(TMP, `gate-${seq++}.${ext}`);
  await writeFile(file, transform(src), 'utf8');
  if (password === undefined) delete process.env.GATE_PASSWORD;
  else process.env.GATE_PASSWORD = password;
  return ext === 'cjs' ? require(file) : import(pathToFileURL(file).href);
}

function setLatePassword(latePassword) {
  if (latePassword !== undefined) process.env.GATE_PASSWORD = latePassword;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i === -1) { if (s) out[s] = ''; continue; }
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

// next/server is absent in this repo, so replace the import with a stand-in.
// The stand-in keeps the same call shapes the template uses.
const NEXT_STUB = `
class __QdaRes {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers ?? {});
    this.body = body ?? null;
    this.cookies = { set() {} };
  }
  static next() { const r = new __QdaRes(null); r.__qdaNext = true; return r; }
  static redirect(url) {
    const r = new __QdaRes(null, { status: 307, headers: { location: String(url) } });
    r.__qdaRedirect = true;
    return r;
  }
}
const NextResponse = __QdaRes;
`;
function stripNextServer(src) {
  const withoutImport = src.replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"]next\/server['"];?\s*$/m, '');
  return NEXT_STUB + '\n' + withoutImport;
}

function normalize(r) {
  return {
    status: r.status,
    gateHeader: r.gateHeader,
    body: r.body,
    contentType: r.contentType ?? null,
    cacheControl: r.cacheControl ?? null,
    contentServed: !!r.contentServed,
  };
}

// Static edge middleware: default export, global Response, cookie via headers.get.
async function runEdge({ password, request, latePassword }) {
  const mod = await loadFresh('edge-middleware.ts', password, 'ts');
  setLatePassword(latePassword);
  const req = {
    headers: { get: (name) => (name.toLowerCase() === 'cookie' ? (request.cookie || null) : null) },
  };
  const res = mod.default(req);
  if (res == null) return normalize({ contentServed: true });
  return normalize({
    status: res.status,
    gateHeader: res.headers.get('x-qda-gate'),
    body: await res.text(),
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    contentServed: false,
  });
}

// Next middleware: named export, NextResponse stub, cookies.get and formData.
async function runNext({ password, request, latePassword }) {
  const mod = await loadFresh('next-middleware.ts', password, 'ts', stripNextServer);
  setLatePassword(latePassword);
  const cookies = parseCookies(request.cookie);
  const req = {
    method: request.method || 'GET',
    url: 'http://localhost/',
    cookies: { get: (name) => (name in cookies ? { value: cookies[name] } : undefined) },
    formData: async () => ({ get: (name) => (name === 'password' ? (request.bodyPassword ?? null) : null) }),
  };
  const res = await mod.middleware(req);
  if (res && res.__qdaNext) return normalize({ contentServed: true });
  return normalize({
    status: res.status,
    gateHeader: res.headers.get('x-qda-gate'),
    body: res.body,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    contentServed: false,
  });
}

// Express gate: CommonJS require, middleware(req, res, next), res.setHeader/end.
async function runExpress({ password, request, latePassword }) {
  const gate = await loadFresh('express-gate.js', password, 'cjs');
  setLatePassword(latePassword);
  return new Promise((resolve) => {
    const headers = {};
    let nextCalled = false;
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(body) {
        resolve(normalize({
          status: res.statusCode,
          gateHeader: headers['x-qda-gate'] ?? null,
          body: body ?? '',
          contentType: headers['content-type'] ?? null,
          cacheControl: headers['cache-control'] ?? null,
          contentServed: nextCalled,
        }));
      },
    };
    const req = new EventEmitter();
    req.method = request.method || 'GET';
    req.url = '/';
    req.headers = { cookie: request.cookie || '' };
    const body = request.bodyPassword ? 'password=' + encodeURIComponent(request.bodyPassword) : '';
    process.nextTick(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
    gate(req, res, () => { nextCalled = true; res.end(); });
  });
}

// Fastify gate: CommonJS hook (request, reply, done), no Fastify installed.
async function runFastify({ password, request, latePassword }) {
  const gate = await loadFresh('fastify-gate.js', password, 'cjs');
  setLatePassword(latePassword);
  return new Promise((resolve) => {
    const headers = {};
    let doneCalled = false;
    const reply = {
      statusCode: 200,
      code(n) { this.statusCode = n; return this; },
      header(k, v) { headers[k.toLowerCase()] = v; return this; },
      send(body) {
        resolve(normalize({
          status: this.statusCode,
          gateHeader: headers['x-qda-gate'] ?? null,
          body: body ?? '',
          contentType: headers['content-type'] ?? null,
          cacheControl: headers['cache-control'] ?? null,
          contentServed: doneCalled,
        }));
        return this;
      },
    };
    const req = new EventEmitter();
    req.method = request.method || 'GET';
    req.url = '/';
    req.headers = { cookie: request.cookie || '' };
    req.raw = req;
    const body = request.bodyPassword ? 'password=' + encodeURIComponent(request.bodyPassword) : '';
    process.nextTick(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
    gate(req, reply, () => { doneCalled = true; reply.send(); });
  });
}

const runners = [
  ['edge (static middleware)', runEdge],
  ['next (middleware)', runNext],
  ['express (gate)', runExpress],
  ['fastify (onRequest hook)', runFastify],
];

for (const [name, run] of runners) {
  test(`${name}: unset, empty and blank password lock GET`, async () => {
    for (const password of [undefined, '', '   ']) {
      const r = await run({ password, request: { method: 'GET' } });
      assert.equal(r.status, 503, `status for ${JSON.stringify(password)}`);
      assert.equal(r.gateHeader, 'locked', 'gate header');
      assert.equal(r.cacheControl, 'no-store', 'cache control');
      assert.equal(r.contentType, 'text/plain; charset=utf-8', 'content type');
      assert.match(r.body, /Locked: the site owner has not finished setting up the sign-in\./);
      assert.equal(r.contentServed, false, 'content must not be served');
    }
  });

  test(`${name}: unset password locks POST and cookie-only attempts`, async () => {
    for (const request of [
      { method: 'POST', bodyPassword: 'anything' },
      { method: 'POST', cookie: 'qda_auth=' },
    ]) {
      const r = await run({ password: undefined, request });
      assert.equal(r.status, 503);
      assert.equal(r.gateHeader, 'locked');
      assert.equal(r.contentServed, false, 'content must not be served');
    }
  });

  test(`${name}: set password serves the form on GET with no cookie`, async () => {
    const r = await run({ password: 's3cret', request: { method: 'GET' } });
    assert.equal(r.status, 200);
    assert.equal(r.gateHeader, 'form');
    assert.equal(r.contentServed, false);
    assert.match(r.body, /type=password/);
  });

  test(`${name}: correct cookie serves content`, async () => {
    const r = await run({ password: 's3cret', request: { method: 'GET', cookie: 'qda_auth=s3cret' } });
    assert.equal(r.contentServed, true, 'content must be served');
  });

  test(`${name}: wrong cookie shows the form and never serves content`, async () => {
    const r = await run({ password: 's3cret', request: { method: 'GET', cookie: 'qda_auth=wrong' } });
    assert.equal(r.status, 200);
    assert.equal(r.gateHeader, 'form');
    assert.equal(r.contentServed, false, 'content must not be served');
  });

  test(`${name}: HEAD matches GET for unset and set passwords`, async () => {
    const locked = await run({ password: undefined, request: { method: 'HEAD' } });
    const lockedGet = await run({ password: undefined, request: { method: 'GET' } });
    assert.equal(locked.status, 503);
    assert.equal(locked.gateHeader, 'locked');
    assert.equal(locked.status, lockedGet.status);
    assert.equal(locked.gateHeader, lockedGet.gateHeader);
    assert.equal(locked.contentServed, lockedGet.contentServed);

    const form = await run({ password: 's3cret', request: { method: 'HEAD' } });
    const formGet = await run({ password: 's3cret', request: { method: 'GET' } });
    assert.equal(form.status, 200);
    assert.equal(form.gateHeader, 'form');
    assert.equal(form.status, formGet.status);
    assert.equal(form.gateHeader, formGet.gateHeader);
    assert.equal(form.contentServed, formGet.contentServed);
  });
}

// The static gate has no POST path, so the sign-in POST cases cover the server gates.
for (const [name, run, ok] of [
  ['next (middleware)', runNext, 307],
  ['express (gate)', runExpress, 303],
  ['fastify (onRequest hook)', runFastify, 303],
]) {
  test(`${name}: a wrong password on POST shows the form and never serves content`, async () => {
    const r = await run({ password: 's3cret', request: { method: 'POST', bodyPassword: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.gateHeader, 'form');
    assert.equal(r.contentServed, false, 'content must not be served');
  });

  test(`${name}: the right password on POST redirects to sign in`, async () => {
    const r = await run({ password: 's3cret', request: { method: 'POST', bodyPassword: 's3cret' } });
    assert.equal(r.status, ok);
    assert.equal(r.contentServed, false);
  });
}

// Low 4: the environment is read when the request is handled, not at load time.
for (const [name, run] of runners) {
  test(`${name}: a password set after load produces the form, not a lock`, async () => {
    const r = await run({ password: undefined, latePassword: 'late-secret', request: { method: 'GET' } });
    assert.equal(r.status, 200);
    assert.equal(r.gateHeader, 'form');
    assert.equal(r.contentServed, false);
  });

  test(`${name}: a cookie matching a late password serves content`, async () => {
    const r = await run({
      password: undefined,
      latePassword: 'late-secret',
      request: { method: 'GET', cookie: 'qda_auth=late-secret' },
    });
    assert.equal(r.contentServed, true, 'content must be served');
  });
}
