const BASE = 'https://api.cloudflare.com/client/v4';

export function makeClient({ token, fetch = globalThis.fetch, chooseAccount, accountId } = {}) {
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(`Cloudflare ${method} ${path} failed: ${JSON.stringify(data.errors ?? data)}`);
    }
    return data.result;
  };

  return {
    async findZone(domain) {
      const zones = await call(`/zones?name=${encodeURIComponent(domain)}`);
      return zones.length ? zones[0].id : null;
    },

    async findAccountId(preferred) {
      const chosen = preferred ?? accountId;
      if (chosen) return chosen;
      const accounts = await call('/accounts');
      if (!accounts.length) return null;
      if (accounts.length === 1) return accounts[0].id;
      const answer = typeof chooseAccount === 'function' ? await chooseAccount(accounts) : null;
      const id = typeof answer === 'string' ? answer : answer?.id;
      if (id && accounts.some((a) => a.id === id)) return id;
      const list = accounts.map((a) => `${a.id}${a.name ? ` (${a.name})` : ''}`).join(', ');
      throw new Error(`More than one Cloudflare account exists. Ask the user which account to use: ${list}.`);
    },

    async getAuthDomain(account) {
      try {
        const org = await call(`/accounts/${account}/access/organizations`);
        const record = Array.isArray(org) ? org[0] : org;
        if (!record?.auth_domain) throw new Error('No auth_domain was returned.');
        return record.auth_domain;
      } catch (error) {
        throw new Error(`Could not read the Zero Trust organisation: ${error.message} If Zero Trust is not enabled, enable it once in the Cloudflare dashboard. If it is, check the token permissions. Then retry.`);
      }
    },

    // Read only. Says whether the hostname is unused, already points at the target, or serves something else.
    async checkCname(zoneId, name, target) {
      const listed = await call(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      const records = Array.isArray(listed) ? listed : [];
      if (!records.length) return { status: 'free' };
      const matches = records.every((r) => r.proxied === true && r.type === 'CNAME' && r.content === target);
      return { status: matches ? 'points-at-target' : 'in-use', records: records.map((r) => ({ id: r.id, type: r.type })) };
    },

    async upsertProxiedCname(zoneId, name, target, { recordId } = {}) {
      const listed = await call(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      const records = Array.isArray(listed) ? listed : [];
      const unproxied = records.find((r) => r.proxied !== true);
      if (unproxied) {
        throw new Error(`Refusing to use DNS record ${unproxied.id} for ${name}: it is not proxied through Cloudflare. Ask the user before changing DNS.`);
      }
      if (recordId) {
        const mine = records.find((r) => r.id === recordId);
        if (!mine) throw new Error(`Record ${recordId} is no longer present for ${name}. Ask the user before changing DNS.`);
        return { id: mine.id, created: true };
      }
      if (records.length) {
        const matching = records.find((r) => r.type === 'CNAME' && r.content === target);
        // A record we did not create stays out of the manifest and teardown.
        if (matching) return { id: matching.id, created: false };
        const ids = records.map((r) => r.id).join(', ');
        throw new Error(`Refusing to overwrite DNS record ${ids} for ${name}: this skill did not create it. Ask the user before changing DNS.`);
      }
      const rec = await call(`/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: { type: 'CNAME', name, content: target, proxied: true, ttl: 1 },
      });
      return { id: rec.id, created: true };
    },

    async createAccessApp(account, hostname) {
      const app = await call(`/accounts/${account}/access/apps`, {
        method: 'POST',
        body: { name: hostname, domain: hostname, type: 'self_hosted', session_duration: '24h' },
      });
      const id = app?.id;
      if (!id) throw new Error('Cloudflare did not return an Access app id.');
      let aud = app?.aud;
      if (!aud) {
        const readBack = await call(`/accounts/${account}/access/apps/${id}`);
        aud = readBack?.aud;
      }
      if (!aud) throw new Error('Cloudflare did not return the Access app aud. Read it from the dashboard and set CF_ACCESS_AUD.');
      return { id, aud };
    },

    async createAccessPolicy(account, appId, emails) {
      const allowed = Array.isArray(emails) ? emails : [emails];
      if (!allowed.length || !allowed.every((e) => typeof e === 'string' && e.includes('@'))) {
        throw new Error('Give at least one email address, and only email addresses.');
      }
      const pol = await call(`/accounts/${account}/access/apps/${appId}/policies`, {
        method: 'POST',
        body: { name: 'qda-allow', decision: 'allow', include: allowed.map((email) => ({ email: { email } })) },
      });
      // The emails come from the Cloudflare answer, so the user sees what was saved.
      const saved = (pol.include ?? []).map((entry) => entry?.email?.email).filter(Boolean);
      return { id: pol.id, emails: saved };
    },

    async deleteAccessPolicy(account, appId, policyId) {
      return call(`/accounts/${account}/access/apps/${appId}/policies/${policyId}`, { method: 'DELETE' });
    },

    async deleteAccessApp(account, appId) {
      return call(`/accounts/${account}/access/apps/${appId}`, { method: 'DELETE' });
    },

    async deleteDnsRecord(zoneId, recordId) {
      return call(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    },
  };
}

// Every client function the Cloudflare route calls has a subcommand.
export const COMMANDS = {
  'find-zone': { usage: '<domain>', run: (cf, [domain]) => cf.findZone(domain) },
  'find-account': { usage: '[accountId]', run: (cf, [id]) => cf.findAccountId(id) },
  'auth-domain': { usage: '<accountId>', run: (cf, [account]) => cf.getAuthDomain(account) },
  'create-app': { usage: '<accountId> <hostname>', run: (cf, [account, host]) => cf.createAccessApp(account, host) },
  'create-policy': { usage: '<accountId> <appId> <email...>', run: (cf, [account, appId, ...emails]) => cf.createAccessPolicy(account, appId, emails) },
  'check-cname': { usage: '<zoneId> <name> <target>', run: (cf, [zoneId, name, target]) => cf.checkCname(zoneId, name, target) },
  'upsert-cname': {
    usage: '<zoneId> <name> <target> [recordId]',
    run: (cf, [zoneId, name, target, recordId]) => cf.upsertProxiedCname(zoneId, name, target, recordId ? { recordId } : {}),
  },
  'delete-policy': { usage: '<accountId> <appId> <policyId>', run: (cf, [account, appId, policyId]) => cf.deleteAccessPolicy(account, appId, policyId) },
  'delete-app': { usage: '<accountId> <appId>', run: (cf, [account, appId]) => cf.deleteAccessApp(account, appId) },
  'delete-dns': { usage: '<zoneId> <recordId>', run: (cf, [zoneId, recordId]) => cf.deleteDnsRecord(zoneId, recordId) },
};

export async function runCommand(command, args, client, out = console.log) {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`unknown command: ${command}`);
  const result = await spec.run(client, args);
  out(typeof result === 'string' ? result : JSON.stringify(result));
  return result;
}

// CLI: node cloudflare.mjs <command> [args]. Reads CF_API_TOKEN from the shell.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , command, ...args] = process.argv;
  const usage = () => console.log(`usage: node cloudflare.mjs <${Object.keys(COMMANDS).join('|')}|help> [args]`);
  if (!command || command === 'help' || command === '--help') {
    usage();
  } else if (!COMMANDS[command]) {
    console.error(`unknown command: ${command}`);
    usage();
    process.exitCode = 1;
  } else if (!process.env.CF_API_TOKEN) {
    console.error('CF_API_TOKEN is required for Cloudflare calls');
    process.exitCode = 1;
  } else {
    const chooseAccount = async (accounts) => {
      const list = accounts.map((a, i) => `${i + 1}) ${a.name ?? ''} ${a.id}`).join('\n');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(`More than one Cloudflare account exists. Ask the user which one to use (number or id):\n${list}\n`)).trim();
        const found = accounts.find((a) => a.id === answer) ?? accounts[Number(answer) - 1];
        if (!found) throw new Error('No matching Cloudflare account was chosen.');
        return found.id;
      } finally {
        rl.close();
      }
    };
    // Without a terminal nobody can answer, so the command lists the accounts and stops.
    const cf = makeClient({ token: process.env.CF_API_TOKEN, chooseAccount: process.stdin.isTTY ? chooseAccount : undefined });
    try {
      await runCommand(command, args, cf);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
