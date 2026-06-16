import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../scripts/cloudflare.mjs';

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url.replace(/https:\/\/api\.cloudflare\.com\/client\/v4/, '')}`;
    const match = Object.keys(routes).find((k) => key.startsWith(k));
    if (!match) throw new Error(`unexpected request: ${key}`);
    return { ok: true, json: async () => ({ success: true, result: routes[match] }) };
  };
}

test('findZone returns the zone id for a domain', async () => {
  const fetch = fakeFetch({ 'GET /zones?name=example.com': [{ id: 'zone123', name: 'example.com' }] });
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.findZone('example.com'), 'zone123');
});

test('findZone returns null when not on Cloudflare', async () => {
  const fetch = fakeFetch({ 'GET /zones?name=nope.com': [] });
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.findZone('nope.com'), null);
});

test('findAccountId returns the first account id', async () => {
  const fetch = fakeFetch({ 'GET /accounts': [{ id: 'acct777' }] });
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.findAccountId(), 'acct777');
});

test('upsertProxiedCname posts a proxied record', async () => {
  let captured;
  const fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ success: true, result: { id: 'rec1' } }) };
  };
  const cf = makeClient({ token: 't', fetch });
  const id = await cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com');
  assert.equal(id, 'rec1');
  assert.equal(captured.type, 'CNAME');
  assert.equal(captured.proxied, true);
  assert.equal(captured.name, 'app1');
});

test('createAccessApp returns the app id and posts self_hosted', async () => {
  let captured;
  const fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ success: true, result: { id: 'app42' } }) };
  };
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.createAccessApp('acct777', 'app1.example.com'), 'app42');
  assert.equal(captured.type, 'self_hosted');
  assert.equal(captured.domain, 'app1.example.com');
});

test('createAccessPolicy returns policy id and includes the email', async () => {
  let captured;
  const fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ success: true, result: { id: 'pol9' } }) };
  };
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.createAccessPolicy('acct777', 'app42', ['me@example.com']), 'pol9');
  assert.equal(captured.decision, 'allow');
  assert.equal(captured.include[0].email.email, 'me@example.com');
});

test('throws on CF failure response', async () => {
  const fetch = async () => ({ ok: false, json: async () => ({ success: false, errors: [{ message: 'bad token' }] }) });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(() => cf.findZone('x.com'), /bad token|failed/);
});
