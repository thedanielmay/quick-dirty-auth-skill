const BASE = 'https://api.cloudflare.com/client/v4';

export function makeClient({ token, fetch = globalThis.fetch }) {
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
    async findAccountId() {
      const accounts = await call(`/accounts`);
      return accounts.length ? accounts[0].id : null;
    },
    async upsertProxiedCname(zoneId, name, target) {
      const rec = await call(`/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: { type: 'CNAME', name, content: target, proxied: true, ttl: 1 },
      });
      return rec.id;
    },
    async createAccessApp(accountId, hostname) {
      const app = await call(`/accounts/${accountId}/access/apps`, {
        method: 'POST',
        body: { name: hostname, domain: hostname, type: 'self_hosted', session_duration: '24h' },
      });
      return app.id;
    },
    async createAccessPolicy(accountId, appId, emails) {
      const pol = await call(`/accounts/${accountId}/access/apps/${appId}/policies`, {
        method: 'POST',
        body: { name: 'qda-allow', decision: 'allow', include: [{ email: { email: emails[0] } }] },
      });
      return pol.id;
    },
  };
}
