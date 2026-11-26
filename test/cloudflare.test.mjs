import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, COMMANDS, runCommand } from '../scripts/cloudflare.mjs';

// Every call is stubbed. A route value of { error: 'text' } gives an API failure,
// and a function lets a test answer a later request differently.
function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url.replace(/https:\/\/api\.cloudflare\.com\/client\/v4/, '')}`;
    const match = Object.keys(routes).find((k) => key.startsWith(k));
    if (!match) throw new Error(`unexpected request: ${key}`);
    const route = routes[match];
    if (route && typeof route === 'object' && !Array.isArray(route) && route.error) {
      return { ok: false, json: async () => ({ success: false, errors: [{ message: route.error }] }) };
    }
    const result = typeof route === 'function' ? route() : route;
    return { ok: true, json: async () => ({ success: true, result }) };
  };
}

function tracingFetch(routes) {
  const calls = [];
  const fetch = fakeFetch(routes);
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, opts: opts ?? {} });
      return fetch(url, opts);
    },
  };
}

const bodyOf = (calls, method) => JSON.parse(calls.find((c) => c.opts.method === method).opts.body);

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

test('findAccountId asks the user when more than one account exists', async () => {
  const accounts = [{ id: 'a1', name: 'First' }, { id: 'a2', name: 'Second' }];
  const fetch = fakeFetch({ 'GET /accounts': accounts });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(() => cf.findAccountId(), /more than one|ask the user/i);
  const chosen = makeClient({ token: 't', fetch, chooseAccount: async (list) => {
    assert.equal(list.length, 2);
    return 'a2';
  } });
  assert.equal(await chosen.findAccountId(), 'a2');
});

test('getAuthDomain reads auth_domain from the organizations endpoint', async () => {
  const { fetch, calls } = tracingFetch({
    'GET /accounts/acct777/access/organizations': { auth_domain: 'team.cloudflareaccess.com' },
  });
  const cf = makeClient({ token: 't', fetch });
  assert.equal(await cf.getAuthDomain('acct777'), 'team.cloudflareaccess.com');
  assert.match(calls[0].url, /\/accounts\/acct777\/access\/organizations$/);
});

test('getAuthDomain reports that Zero Trust is not enabled on failure', async () => {
  const fetch = fakeFetch({ 'GET /accounts/acct777/access/organizations': { error: 'not found' } });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(() => cf.getAuthDomain('acct777'), /Zero Trust/);
});

test('upsertProxiedCname creates a proxied CNAME after checking for an existing record', async () => {
  const { fetch, calls } = tracingFetch({
    'GET /zones/zone123/dns_records?name=app1': [],
    'POST /zones/zone123/dns_records': { id: 'rec1' },
  });
  const cf = makeClient({ token: 't', fetch });
  assert.deepEqual(await cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com'), { id: 'rec1', created: true });
  assert.equal(calls[0].opts.method, 'GET', 'the existing record is read first');
  const created = bodyOf(calls, 'POST');
  assert.equal(created.type, 'CNAME');
  assert.equal(created.proxied, true);
  assert.equal(created.name, 'app1');
  assert.equal(created.content, 'cname.vercel-dns.com');
});

test('upsertProxiedCname refuses to overwrite a record this skill did not create', async () => {
  let posted = false;
  const fetch = fakeFetch({
    'GET /zones/zone123/dns_records?name=app1': [{ id: 'rec9', type: 'A', content: '192.0.2.1', proxied: true }],
    'POST /zones/zone123/dns_records': () => { posted = true; return { id: 'new' }; },
  });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(() => cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com'), /Refusing to overwrite/);
  assert.equal(posted, false, 'no record may be replaced');
});

test('upsertProxiedCname refuses an existing record that is not proxied', async () => {
  let posted = false;
  const fetch = fakeFetch({
    'GET /zones/zone123/dns_records?name=app1': [{
      id: 'rec8', type: 'CNAME', content: 'cname.vercel-dns.com', proxied: false,
    }],
    'POST /zones/zone123/dns_records': () => { posted = true; return { id: 'new' }; },
  });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(
    () => cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com'),
    /not proxied/i,
  );
  assert.equal(posted, false);
});

test('upsertProxiedCname marks a reused record as not created', async () => {
  let posted = false;
  const fetch = fakeFetch({
    'GET /zones/zone123/dns_records?name=app1': [{
      id: 'rec9', type: 'CNAME', content: 'cname.vercel-dns.com', proxied: true,
    }],
    'POST /zones/zone123/dns_records': () => { posted = true; return { id: 'new' }; },
  });
  const cf = makeClient({ token: 't', fetch });
  assert.deepEqual(
    await cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com'),
    { id: 'rec9', created: false },
    'a reused record must never be recorded for teardown',
  );
  assert.equal(posted, false);
});

test('upsertProxiedCname marks a recorded record as created', async () => {
  const fetch = fakeFetch({
    'GET /zones/zone123/dns_records?name=app1': [{
      id: 'rec9', type: 'CNAME', content: 'cname.vercel-dns.com', proxied: true,
    }],
  });
  const cf = makeClient({ token: 't', fetch });
  assert.deepEqual(
    await cf.upsertProxiedCname('zone123', 'app1', 'cname.vercel-dns.com', { recordId: 'rec9' }),
    { id: 'rec9', created: true },
  );
});

test('createAccessApp returns the app id and its audience', async () => {
  const { fetch, calls } = tracingFetch({
    'POST /accounts/acct777/access/apps': { id: 'app42', aud: 'aud-created' },
  });
  const cf = makeClient({ token: 't', fetch });
  assert.deepEqual(await cf.createAccessApp('acct777', 'app1.example.com'), { id: 'app42', aud: 'aud-created' });
  const body = bodyOf(calls, 'POST');
  assert.equal(body.name, 'app1.example.com');
  assert.equal(body.domain, 'app1.example.com');
  assert.equal(body.type, 'self_hosted');
  assert.equal(body.session_duration, '24h');
});

test('createAccessApp falls back to a GET when the create response has no aud', async () => {
  const { fetch, calls } = tracingFetch({
    'POST /accounts/acct777/access/apps': { id: 'app42' },
    'GET /accounts/acct777/access/apps/app42': { id: 'app42', aud: 'aud-read-back' },
  });
  const cf = makeClient({ token: 't', fetch });
  assert.deepEqual(await cf.createAccessApp('acct777', 'app1.example.com'), { id: 'app42', aud: 'aud-read-back' });
  assert.match(calls[1].url, /\/accounts\/acct777\/access\/apps\/app42$/);
});

test('createAccessPolicy includes every email', async () => {
  const { fetch, calls } = tracingFetch({
    'POST /accounts/acct777/access/apps/app42/policies': { id: 'pol9' },
  });
  const cf = makeClient({ token: 't', fetch });
  const emails = ['one@example.com', 'two@example.com', 'three@example.com'];
  assert.equal(await cf.createAccessPolicy('acct777', 'app42', emails), 'pol9');
  const body = bodyOf(calls, 'POST');
  assert.equal(body.name, 'qda-allow');
  assert.equal(body.decision, 'allow');
  assert.deepEqual(body.include.map((entry) => entry.email.email), emails);
});

test('deleteAccessPolicy deletes the recorded policy', async () => {
  const { fetch, calls } = tracingFetch({
    'DELETE /accounts/acct777/access/apps/app42/policies/pol9': {},
  });
  const cf = makeClient({ token: 't', fetch });
  await cf.deleteAccessPolicy('acct777', 'app42', 'pol9');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[0].url, /\/accounts\/acct777\/access\/apps\/app42\/policies\/pol9$/);
});

test('deleteAccessApp deletes the recorded app', async () => {
  const { fetch, calls } = tracingFetch({
    'DELETE /accounts/acct777/access/apps/app42': {},
  });
  const cf = makeClient({ token: 't', fetch });
  await cf.deleteAccessApp('acct777', 'app42');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[0].url, /\/accounts\/acct777\/access\/apps\/app42$/);
});

test('deleteDnsRecord deletes the recorded zone record', async () => {
  const { fetch, calls } = tracingFetch({
    'DELETE /zones/zone123/dns_records/rec1': {},
  });
  const cf = makeClient({ token: 't', fetch });
  await cf.deleteDnsRecord('zone123', 'rec1');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[0].url, /\/zones\/zone123\/dns_records\/rec1$/);
});

test('every call carries the bearer token', async () => {
  const { fetch, calls } = tracingFetch({ 'GET /accounts': [{ id: 'acct777' }] });
  const cf = makeClient({ token: 'secret-token', fetch });
  await cf.findAccountId();
  assert.equal(calls[0].opts.headers.authorization, 'Bearer secret-token');
});

test('throws on CF failure response', async () => {
  const fetch = async () => ({ ok: false, json: async () => ({ success: false, errors: [{ message: 'bad token' }] }) });
  const cf = makeClient({ token: 't', fetch });
  await assert.rejects(() => cf.findZone('x.com'), /bad token|failed/);
});

// The Cloudflare route calls each of these client functions. The command line
// must expose all of them, including the CNAME step that was missing.
const commandMethods = [
  ['find-zone', 'findZone'],
  ['find-account', 'findAccountId'],
  ['auth-domain', 'getAuthDomain'],
  ['create-app', 'createAccessApp'],
  ['create-policy', 'createAccessPolicy'],
  ['upsert-cname', 'upsertProxiedCname'],
  ['delete-policy', 'deleteAccessPolicy'],
  ['delete-app', 'deleteAccessApp'],
  ['delete-dns', 'deleteDnsRecord'],
];

test('the CLI lists every command the Cloudflare steps call', () => {
  for (const [command] of commandMethods) {
    assert.ok(COMMANDS[command], `${command} must have a CLI subcommand`);
    assert.equal(typeof COMMANDS[command].run, 'function');
  }
});

for (const [command, method] of commandMethods) {
  test(`runCommand ${command} calls ${method}`, async () => {
    let captured = null;
    const client = new Proxy({}, {
      get: (_, name) => async (...args) => { captured = { name, args }; return 'ok'; },
    });
    const printed = [];
    await runCommand(command, ['a', 'b', 'c'], client, (value) => printed.push(value));
    assert.equal(captured?.name, method);
    assert.deepEqual(printed, ['ok']);
  });
}

test('runCommand passes an optional record id to the CNAME step', async () => {
  let captured = null;
  const client = {
    upsertProxiedCname: async (...args) => {
      captured = args;
      return { id: 'rec1', created: true };
    },
  };
  const printed = [];
  await runCommand('upsert-cname', ['zone123', 'app1', 'cname.vercel-dns.com', 'rec9'], client,
    (value) => printed.push(value));
  assert.deepEqual(captured, ['zone123', 'app1', 'cname.vercel-dns.com', { recordId: 'rec9' }]);
  assert.deepEqual(JSON.parse(printed[0]), { id: 'rec1', created: true });
});

test('runCommand rejects an unknown command', async () => {
  await assert.rejects(() => runCommand('not-a-command', [], {}, () => {}), /unknown command/i);
});
