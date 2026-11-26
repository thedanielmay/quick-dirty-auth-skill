import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';

// Offline contract for the Cloudflare Access route. The key pair is generated
// here and the cert endpoint is a stubbed fetch, so no account is needed.
const TMP = await mkdtemp(join(tmpdir(), 'qda-access-'));
after(() => rm(TMP, { recursive: true, force: true }));

const { subtle } = webcrypto;
const TEAM = 'qda-test.cloudflareaccess.com';
const AUD = 'qda-audience';
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
const ACCESS_ENV = { team: TEAM, aud: AUD };
const ENV_KEYS = ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'GATE_PASSWORD'];

const keyOptions = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};
const pair = await subtle.generateKey(keyOptions, true, ['sign', 'verify']);
const other = await subtle.generateKey(keyOptions, true, ['sign', 'verify']);
const third = await subtle.generateKey(keyOptions, true, ['sign', 'verify']);
const rotated = await subtle.generateKey(keyOptions, true, ['sign', 'verify']);
const pubJwk = { ...(await subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const otherJwk = { ...(await subtle.exportKey('jwk', other.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const thirdJwk = { ...(await subtle.exportKey('jwk', third.publicKey)), kid: 'k3', alg: 'RS256', use: 'sig' };
const rotatedJwk = { ...(await subtle.exportKey('jwk', rotated.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

const b64 = (value) => Buffer.from(value).toString('base64url');
const jsonPart = (value) => b64(JSON.stringify(value));

async function token(claims = {}, { key = pair.privateKey, header = { alg: 'RS256', typ: 'JWT', kid: 'k1' } } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: `https://${TEAM}`,
    aud: AUD,
    exp: now + 600,
    nbf: now - 60,
    email: 'reader@example.com',
    ...claims,
  };
  const input = `${jsonPart(header)}.${jsonPart(body)}`;
  const sig = await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let fetchCalls = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  fetchCalls = [];
  applyEnv({});
});

// Cache windows are measured in real time. A fixed clock keeps the tests fast.
function atClock(ms) {
  Date.now = () => ms;
}

function applyEnv({ team, aud, password } = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  if (team !== undefined) process.env.CF_ACCESS_TEAM_DOMAIN = team;
  if (aud !== undefined) process.env.CF_ACCESS_AUD = aud;
  if (password !== undefined) process.env.GATE_PASSWORD = password;
}

function stubFetch(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const answer = typeof responder === 'function' ? responder(fetchCalls.length) : responder;
    if (answer === 'throw') throw new Error('cert endpoint down');
    return answer ?? { ok: true, status: 200, json: async () => ({ keys: [pubJwk] }) };
  };
}

const normal = (r) => ({
  status: r.status ?? null,
  gateHeader: r.gateHeader ?? null,
  body: r.body ?? '',
  contentType: r.contentType ?? null,
  cacheControl: r.cacheControl ?? null,
  served: Boolean(r.served),
  hijacked: Boolean(r.hijacked),
  location: r.location ?? null,
  bodyRead: Boolean(r.bodyRead),
});

async function fromResponse(res) {
  if (res == null || res.__qdaNext) return normal({ served: true });
  return normal({
    status: res.status,
    gateHeader: res.headers.get('x-qda-gate'),
    body: typeof res.text === 'function' ? await res.text() : res.body,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
  });
}

const require = createRequire(import.meta.url);
let seq = 0;
async function fresh(name, ext) {
  const src = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
  const file = join(TMP, `gate-${seq++}.${ext}`);
  await writeFile(file, src, 'utf8');
  return ext === 'cjs' ? require(file) : import(pathToFileURL(file).href);
}

// next/server is not installed here. This stand-in keeps the call shapes the
// template uses so the gate can be exercised without a Next.js project.
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
async function freshNext() {
  const src = await readFile(new URL('../templates/next-middleware.ts', import.meta.url), 'utf8');
  const withoutImport = src.replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"]next\/server['"];?\s*$/m, '');
  const file = join(TMP, `gate-${seq++}.ts`);
  await writeFile(file, NEXT_STUB + '\n' + withoutImport, 'utf8');
  return import(pathToFileURL(file).href);
}

// The request body arrives after the gate has had the chance to listen for it.
function sendBody(req, request) {
  process.nextTick(() => {
    if (request.body) req.emit('data', Buffer.from(request.body));
    req.emit('end');
  });
}

function headerValue(request) {
  return request.token ?? null;
}

// Each loader returns an invoke function. The environment is applied at invoke
// time, which also proves the gate does not capture it when the module loads.
const runners = [
  ['edge (static middleware)', async () => {
    const mod = await fresh('edge-middleware.ts', 'ts');
    return async (request, env) => {
      applyEnv(env);
      const res = await mod.default({ headers: { get: (n) => (n.toLowerCase() === 'cf-access-jwt-assertion' ? headerValue(request) : null) } });
      return fromResponse(res);
    };
  }],
  ['next (middleware)', async () => {
    const mod = await freshNext();
    return async (request, env) => {
      applyEnv(env);
      const cookies = {};
      for (const part of (request.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i !== -1) cookies[part.slice(0, i).trim()] = part.slice(i + 1);
      }
      const req = {
        method: request.method || 'GET',
        url: 'http://localhost/',
        headers: { get: (n) => (n.toLowerCase() === 'cf-access-jwt-assertion' ? headerValue(request) : null) },
        cookies: { get: (name) => (name in cookies ? { value: cookies[name] } : undefined) },
        formData: async () => ({ get: (name) => (name === 'password' ? request.password ?? null : null) }),
      };
      return fromResponse(await mod.middleware(req));
    };
  }],
  ['express (gate)', async () => {
    const gate = await fresh('express-gate.js', 'cjs');
    return async (request, env) => new Promise((resolve) => {
      applyEnv(env);
      const headers = {};
      let served = false;
      const res = {
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        end(body) {
          resolve(normal({
            status: res.statusCode,
            gateHeader: headers['x-qda-gate'] ?? null,
            body: body ?? '',
            contentType: headers['content-type'] ?? null,
            cacheControl: headers['cache-control'] ?? null,
            served,
            location: headers.location,
            bodyRead: req.listenerCount('data') > 0,
          }));
        },
      };
      const req = new EventEmitter();
      req.method = request.method || 'GET';
      req.url = request.url ?? '/';
      req.headers = {};
      if (headerValue(request) != null) req.headers['cf-access-jwt-assertion'] = headerValue(request);
      if (request.cookie) req.headers.cookie = request.cookie;
      const done = () => { served = true; res.end(); };
      sendBody(req, request);
      Promise.resolve(gate(req, res, done)).catch(() => {
        res.statusCode = 403;
        res.end('async error');
      });
    });
  }],
  ['fastify (onRequest hook)', async () => {
    const gate = await fresh('fastify-gate.js', 'cjs');
    return async (request, env) => new Promise((resolve) => {
      applyEnv(env);
      const headers = {};
      let served = false;
      let hijacked = false;
      let finished = false;
      const finish = (body) => {
        if (finished) return;
        finished = true;
        resolve(normal({
          status: raw.statusCode,
          gateHeader: headers['x-qda-gate'] ?? null,
          body: body ?? '',
          contentType: headers['content-type'] ?? null,
          cacheControl: headers['cache-control'] ?? null,
          served,
          hijacked,
          location: headers.location,
          bodyRead: req.listenerCount('data') > 0,
        }));
      };
      const raw = {
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        end: finish,
      };
      const reply = {
        raw,
        hijack() { hijacked = true; },
        code(n) { raw.statusCode = n; return this; },
        header(k, v) { raw.setHeader(k, v); return this; },
        send(body) { finish(body); return this; },
      };
      const req = new EventEmitter();
      req.method = request.method || 'GET';
      req.url = request.url ?? '/';
      req.headers = {};
      if (headerValue(request) != null) req.headers['cf-access-jwt-assertion'] = headerValue(request);
      if (request.cookie) req.headers.cookie = request.cookie;
      req.raw = req;
      const done = () => { served = true; finish(); };
      sendBody(req, request);
      Promise.resolve(gate(req, reply, done)).catch(() => {
        raw.statusCode = 403;
        finish('async error');
      });
    });
  }],
];

for (const [name, load] of runners) {
  test(`${name}: a valid Access JWT serves content`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ token: await token() }, ACCESS_ENV);
    assert.equal(r.served, true, 'content must be served');
    assert.equal(r.gateHeader, null);
    assert.equal(fetchCalls.length, 1, 'the cert endpoint is read once');
    assert.equal(fetchCalls[0].url, CERTS);
  });

  test(`${name}: no JWT is denied with 403 access`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({}, ACCESS_ENV);
    assert.equal(r.status, 403);
    assert.equal(r.gateHeader, 'access');
    assert.equal(r.served, false);
    assert.equal(fetchCalls.length, 0, 'no header means no cert lookup');
  });

  for (const [caseName, claims, header] of [
    ['wrong audience', { aud: 'someone-else' }, undefined],
    ['wrong issuer', { iss: 'https://elsewhere.cloudflareaccess.com' }, undefined],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }, undefined],
    ['future nbf', { nbf: Math.floor(Date.now() / 1000) + 600 }, undefined],
    ['alg none', {}, { alg: 'none', typ: 'JWT', kid: 'k1' }],
    ['HS256', {}, { alg: 'HS256', typ: 'JWT', kid: 'k1' }],
  ]) {
    test(`${name}: ${caseName} is denied`, async () => {
      stubFetch();
      const invoke = await load();
      const options = { header };
      const bad = await token(claims, options);
      const r = await invoke({ token: bad }, ACCESS_ENV);
      assert.equal(r.status, 403, caseName);
      assert.equal(r.gateHeader, 'access');
      assert.equal(r.served, false);
      if (header) assert.equal(fetchCalls.length, 0, 'the algorithm is checked before key lookup');
    });
  }

  test(`${name}: the same kid signed by another key is denied`, async () => {
    stubFetch();
    const invoke = await load();
    const bad = await token({}, { key: other.privateKey });
    const r = await invoke({ token: bad }, ACCESS_ENV);
    assert.equal(r.status, 403);
    assert.equal(r.gateHeader, 'access');
    assert.equal(r.served, false);
  });

  test(`${name}: an audience array that contains the AUD passes`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ token: await token({ aud: ['other', AUD] }) }, ACCESS_ENV);
    assert.equal(r.served, true);
  });

  test(`${name}: a team domain with a scheme is normalised`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ token: await token() }, { team: `https://${TEAM}/`, aud: AUD });
    assert.equal(r.served, true);
    assert.equal(fetchCalls[0].url, CERTS);
  });

  test(`${name}: an unknown kid triggers one refetch`, async () => {
    stubFetch((n) => ({
      ok: true,
      json: async () => ({ keys: n === 1 ? [pubJwk] : [{ ...otherJwk, kid: 'k2' }] }),
    }));
    const invoke = await load();
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true, 'first request caches k1');
    assert.equal(fetchCalls.length, 1);
    const freshToken = await token({}, { key: other.privateKey, header: { alg: 'RS256', typ: 'JWT', kid: 'k2' } });
    const r = await invoke({ token: freshToken }, ACCESS_ENV);
    assert.equal(r.served, true);
    assert.equal(fetchCalls.length, 2, 'one cached lookup and one refetch');
  });

  test(`${name}: an unknown kid gets at most one refetch per 60 seconds`, async () => {
    let clock = 1_800_000_000_000;
    atClock(clock);
    stubFetch((n) => ({
      ok: true,
      json: async () => ({
        keys: n === 1 ? [pubJwk] : n === 2 ? [{ ...otherJwk, kid: 'k2' }] : [thirdJwk],
      }),
    }));
    const invoke = await load();
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true, 'first request caches k1');
    const second = await token({}, { key: other.privateKey, header: { alg: 'RS256', typ: 'JWT', kid: 'k2' } });
    assert.equal((await invoke({ token: second }, ACCESS_ENV)).served, true, 'one refetch finds k2');
    assert.equal(fetchCalls.length, 2);

    const thirdToken = await token({}, { key: third.privateKey, header: { alg: 'RS256', typ: 'JWT', kid: 'k3' } });
    const insideWindow = await invoke({ token: thirdToken }, ACCESS_ENV);
    assert.equal(insideWindow.status, 403);
    assert.equal(insideWindow.gateHeader, 'access');
    assert.equal(fetchCalls.length, 2, 'no fetch inside the 60 second window');

    clock += 61_000;
    atClock(clock);
    const afterWindow = await token({}, { key: third.privateKey, header: { alg: 'RS256', typ: 'JWT', kid: 'k3' } });
    assert.equal((await invoke({ token: afterWindow }, ACCESS_ENV)).served, true);
    assert.equal(fetchCalls.length, 3, 'one refetch after the window');
  });

  test(`${name}: cached keys refresh after one hour and survive one more hour when a refresh fails`, async () => {
    let clock = 1_800_000_000_000;
    atClock(clock);
    stubFetch((n) => ({ ok: true, json: async () => ({ keys: n === 1 ? [pubJwk] : [rotatedJwk] }) }));
    const invoke = await load();
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true);
    assert.equal(fetchCalls.length, 1);

    clock += 59 * 60 * 1000;
    atClock(clock);
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true);
    assert.equal(fetchCalls.length, 1, 'no refresh before one hour');

    clock += 2 * 60 * 1000;
    atClock(clock);
    const oldKeyToken = await token();
    const stale = await invoke({ token: oldKeyToken }, ACCESS_ENV);
    assert.equal(stale.status, 403, 'the rotated key replaces the cached one');
    assert.equal(fetchCalls.length, 2, 'refresh happens at one hour');
    const rotatedToken = await token({}, { key: rotated.privateKey });
    assert.equal((await invoke({ token: rotatedToken }, ACCESS_ENV)).served, true);
    assert.equal(fetchCalls.length, 2);

    clock += 61 * 60 * 1000;
    atClock(clock);
    stubFetch('throw');
    const kept = await invoke({ token: await token({}, { key: rotated.privateKey }) }, ACCESS_ENV);
    assert.equal(kept.served, true, 'a failed refresh keeps the cached keys');
    assert.equal(fetchCalls.length, 1, 'the refresh was attempted');
    await invoke({ token: await token({}, { key: rotated.privateKey }) }, ACCESS_ENV);
    assert.equal(fetchCalls.length, 1, 'no second attempt inside 60 seconds');

    clock += 60 * 60 * 1000;
    atClock(clock);
    const failed = await invoke({ token: await token({}, { key: rotated.privateKey }) }, ACCESS_ENV);
    assert.equal(failed.status, 403);
    assert.equal(failed.gateHeader, 'access');
  });

  test(`${name}: many unknown kids at once cause one fetch, also when it fails`, async () => {
    atClock(1_800_000_000_000);
    stubFetch(() => ({ ok: true, json: async () => ({ keys: [pubJwk] }) }));
    const invoke = await load();
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true);
    stubFetch(() => ({ ok: false, json: async () => ({}) }));
    const strangers = await Promise.all(Array.from({ length: 20 }, async (_, n) => token({}, { header: { alg: 'RS256', typ: 'JWT', kid: `x${n}` } })));
    const results = await Promise.all(strangers.map((value) => invoke({ token: value }, ACCESS_ENV)));
    assert.ok(results.every((r) => r.served === false));
    await invoke({ token: strangers[0] }, ACCESS_ENV);
    assert.equal(fetchCalls.length, 1, 'one shared fetch, then none inside the window');
    assert.equal((await invoke({ token: await token() }, ACCESS_ENV)).served, true, 'a known user still gets in');
  });

  test(`${name}: a cert fetch that throws denies`, async () => {
    stubFetch('throw');
    const invoke = await load();
    const r = await invoke({ token: await token() }, ACCESS_ENV);
    assert.equal(r.status, 403);
    assert.equal(r.gateHeader, 'access');
    assert.equal(r.served, false);
  });

  test(`${name}: an unsuccessful cert response denies`, async () => {
    stubFetch({ ok: false, status: 500, json: async () => ({}) });
    const invoke = await load();
    const r = await invoke({ token: await token() }, ACCESS_ENV);
    assert.equal(r.status, 403);
    assert.equal(r.gateHeader, 'access');
    assert.equal(r.served, false);
  });

  test(`${name}: a malformed JWT denies without a cert lookup`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ token: 'not-a-jwt' }, ACCESS_ENV);
    assert.equal(r.status, 403);
    assert.equal(r.gateHeader, 'access');
    assert.equal(fetchCalls.length, 0);
  });

  test(`${name}: a partial Access setup stays locked`, async () => {
    stubFetch();
    const invoke = await load();
    for (const env of [{ team: TEAM }, { aud: AUD }]) {
      const r = await invoke({ token: await token() }, env);
      assert.equal(r.status, 503, 'partial setup must lock');
      assert.equal(r.gateHeader, 'locked');
      assert.equal(r.cacheControl, 'no-store');
      assert.equal(r.served, false);
    }
    assert.equal(fetchCalls.length, 0);
  });

  test(`${name}: a password alone keeps the password gate`, async () => {
    const invoke = await load();
    const r = await invoke({ method: 'GET' }, { password: 's3cret' });
    assert.equal(r.status, 200);
    assert.equal(r.gateHeader, 'form');
    assert.equal(r.served, false);
    assert.match(r.body, /type=password/);
  });

  test(`${name}: the password is ignored when Access is configured`, async () => {
    stubFetch();
    const invoke = await load();
    const env = { team: TEAM, aud: AUD, password: 's3cret' };
    const denied = await invoke({ cookie: 'qda_auth=s3cret' }, env);
    assert.equal(denied.status, 403);
    assert.equal(denied.gateHeader, 'access');
    assert.equal(denied.served, false);
    const allowed = await invoke({ token: await token() }, env);
    assert.equal(allowed.served, true);
  });
}

for (const [name, load] of runners) {
  test(`${name}: cert keys are cached across requests`, async () => {
    stubFetch();
    const invoke = await load();
    const jwt = await token();
    const first = await invoke({ token: jwt }, ACCESS_ENV);
    const second = await invoke({ token: jwt }, ACCESS_ENV);
    assert.equal(first.served, true);
    assert.equal(second.served, true);
    assert.equal(fetchCalls.length, 1, 'the second request uses the cached key');
  });

}

test('Fastify hijacks only when it ends the response', async () => {
  const [, load] = runners.find(([n]) => n.startsWith('fastify'));
  stubFetch();
  const invoke = await load();
  const denied = await invoke({}, ACCESS_ENV);
  assert.equal(denied.hijacked, true, 'the hook owns the raw response');
  const served = await invoke({ token: await token() }, ACCESS_ENV);
  assert.equal(served.served, true);
  assert.equal(served.hijacked, false, 'Fastify continues the request on success');
});

test('the Node server gates load Web Crypto from node:crypto for Node 18', async () => {
  for (const name of ['express-gate.js', 'fastify-gate.js']) {
    const src = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
    assert.match(src, /require\(['"]node:crypto['"]\)\.webcrypto/, name);
  }
});

test('every gate template stays self contained', async () => {
  for (const name of [
    'next-middleware.ts', 'edge-middleware.ts', 'express-gate.js', 'fastify-gate.js',
  ]) {
    const src = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]\.\.\/scripts|require\(['"]\.\.\/scripts/, name);
  }
});

async function matcherLine(template) {
  const src = await readFile(new URL(`../templates/${template}`, import.meta.url), 'utf8');
  const line = src.match(/export const config = \{ matcher: (.+) \};/);
  assert.ok(line, `${template} declares a matcher`);
  return line[1].trim();
}

test('the static gate matcher covers every path, the favicon included', async () => {
  assert.equal(await matcherLine('edge-middleware.ts'), "'/:path*'");
});

test('the Next.js gate matcher skips only built assets and image resizing', async () => {
  const literal = (await matcherLine('next-middleware.ts')).replace(/^\[|\]$/g, '').replace(/'/g, '"');
  const pattern = new RegExp(`^${JSON.parse(literal)}$`);
  for (const path of ['/', '/favicon.ico', '/api/data', '/_next/staticx', '/_next/data/page.json']) {
    assert.equal(pattern.test(path), true, `${path} must be gated`);
  }
  for (const path of ['/_next/static/chunk.js', '/_next/image']) {
    assert.equal(pattern.test(path), false, `${path} is a built asset`);
  }
});

// The sign-in request limit and the same-site redirect belong to the password
// gate. With Access configured, the gate never reads the body and never redirects.
for (const [name, load] of runners.filter(([n]) => /^(express|fastify)/.test(n))) {
  const big = 'password=' + 'x'.repeat(5000);

  test(`${name}: Access mode denies a sign-in post without reading it`, async () => {
    stubFetch();
    const invoke = await load();
    const env = { ...ACCESS_ENV, password: 's3cret' };
    for (const body of ['password=s3cret', big]) {
      const r = await invoke({ method: 'POST', url: '//other.example', body }, env);
      assert.equal(r.status, 403);
      assert.equal(r.gateHeader, 'access');
      assert.equal(r.location, null);
      assert.equal(r.served, false);
      assert.equal(r.bodyRead, false);
    }
  });

  test(`${name}: Access mode hands a large post with a valid token to the app unread`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ method: 'POST', body: big, token: await token() }, ACCESS_ENV);
    assert.equal(r.served, true);
    assert.equal(r.bodyRead, false);
  });

  test(`${name}: a partial Access setup locks a large post`, async () => {
    stubFetch();
    const invoke = await load();
    const r = await invoke({ method: 'POST', body: big }, { team: TEAM, password: 's3cret' });
    assert.equal(r.status, 503);
    assert.equal(r.gateHeader, 'locked');
    assert.equal(r.served, false);
  });

  test(`${name}: blank Access variables keep the request limit and the same-site redirect`, async () => {
    const invoke = await load();
    const env = { team: '  ', aud: '', password: 's3cret' };
    const tooBig = await invoke({ method: 'POST', body: big }, env);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.served, false);
    for (const [url, expected] of [['/a?b=1', '/a?b=1'], ['//other.example', '/'], ['/\\other.example', '/']]) {
      const r = await invoke({ method: 'POST', url, body: 'password=s3cret' }, env);
      assert.equal(r.status, 303, url);
      assert.equal(r.location, expected, url);
      assert.equal(r.served, false, url);
    }
  });
}

test('every template puts a time limit on the certificate request', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['express-gate.js', 'fastify-gate.js', 'next-middleware.ts', 'edge-middleware.ts']) {
    const source = await readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
    assert.match(source, /fetch\(url, \{ signal: AbortSignal\.timeout\(5000\) \}\)/, name);
  }
});
