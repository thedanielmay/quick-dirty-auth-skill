// qda-gate: quick-dirty-auth
// templates/express-gate.js → copied into a Node/Express project; mount before routes:
//   const gate = require('./qda-gate'); app.use(gate);
const COOKIE = 'qda_auth';
const LOCKED_TEXT = 'Locked: the site owner has not finished setting up the sign-in.';
const DENIED_TEXT = 'Access denied: Cloudflare Access did not authorise this request.';
// Node 18 has webcrypto here but not always on globalThis.
const CRYPTO = globalThis.crypto?.subtle ? globalThis.crypto : require('node:crypto').webcrypto;
const certCache = new Map();
const REFRESH_MS = 60 * 60 * 1000;
const REFETCH_MS = 60 * 1000;

async function fetchKeys(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('certificate fetch failed');
  const data = await response.json();
  if (!Array.isArray(data?.keys)) throw new Error('certificate keys missing');
  return data.keys;
}

async function cachedKeys(url, kid) {
  const now = Date.now();
  let entry = certCache.get(url);
  if (!entry) {
    entry = { keys: null, fetchedAt: 0, refetchedAt: -REFETCH_MS, failedAt: -REFETCH_MS, pending: null };
    certCache.set(url, entry);
  }
  const old = !entry.keys || now - entry.fetchedAt >= REFRESH_MS;
  const unknown = !old && !entry.keys.some((k) => k && k.kid === kid);
  // One fetch at a time. Refresh waits 60 seconds after a failure. Unknown kids get one fetch per 60 seconds.
  const due = (old && now - entry.failedAt >= REFETCH_MS) || (unknown && now - entry.refetchedAt >= REFETCH_MS);
  if (!entry.pending && due) {
    if (unknown) entry.refetchedAt = now;
    entry.pending = fetchKeys(url)
      .then((keys) => { entry.keys = keys; entry.fetchedAt = now; })
      .catch(() => { entry.failedAt = now; })
      .finally(() => { entry.pending = null; });
  }
  if (entry.pending && (old || unknown)) await entry.pending;
  // When a refresh fails, the cached keys stay usable for one extra hour at most.
  if (!entry.keys || Date.now() - entry.fetchedAt >= 2 * REFRESH_MS) return null;
  return entry.keys;
}

const page = (error = '') =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Protected</title>
  <style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#eee}
  form{display:grid;gap:12px;width:min(320px,90vw)}input,button{padding:12px;border-radius:8px;font-size:16px}
  input{border:1px solid #333;background:#161618;color:#eee}button{border:0;background:#3b82f6;color:#fff;cursor:pointer}
  .err{color:#f87171;min-height:1.2em;font-size:14px}</style>
  <form method=POST><div class=err>${error}</div>
  <input type=password name=password placeholder=Password autofocus required>
  <button>Enter</button></form>`;

const teamName = (raw) => String(raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const bytes = (part) => {
  const base64 = String(part).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json = (part) => JSON.parse(new TextDecoder().decode(bytes(part)));

async function verifyAccess(jwt, team, aud) {
  try {
    if (typeof jwt !== 'string' || !jwt) return false;
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const header = json(parts[0]);
    // Reject a forged algorithm before any key lookup.
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return false;
    const url = `https://${team}/cdn-cgi/access/certs`;
    const keys = await cachedKeys(url, header.kid);
    if (!keys) return false;
    const jwk = keys.find((k) => k && k.kid === header.kid);
    if (!jwk) return false;
    const key = await CRYPTO.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify'],
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await CRYPTO.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, bytes(parts[2]), signed);
    if (!valid) return false;
    const claims = json(parts[1]);
    if (!claims || claims.iss !== `https://${team}`) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now)) return false;
    return true;
  } catch {
    return false;
  }
}

const send = (res, status, gate, text, contentType = 'text/plain; charset=utf-8') => {
  res.statusCode = status;
  res.setHeader('x-qda-gate', gate);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', contentType);
  res.end(text);
};
const locked = (res) => send(res, 503, 'locked', LOCKED_TEXT);
const denied = (res) => send(res, 403, 'access', DENIED_TEXT);

module.exports = function qdaGate(req, res, next) {
  // Read the environment on each request. A setup change needs no redeploy.
  const team = teamName(process.env.CF_ACCESS_TEAM_DOMAIN);
  const aud = String(process.env.CF_ACCESS_AUD ?? '').trim();
  const hasTeam = Boolean(team);
  const hasAud = Boolean(aud);
  if (hasTeam !== hasAud) return locked(res);
  if (hasTeam && hasAud) {
    const supplied = req.headers?.['cf-access-jwt-assertion'];
    const jwt = Array.isArray(supplied) ? supplied[0] : supplied;
    Promise.resolve(verifyAccess(jwt, team, aud)).then(
      (ok) => { if (ok) next(); else denied(res); },
      () => denied(res),
    );
    return;
  }

  const PASSWORD = process.env.GATE_PASSWORD || '';
  if (!PASSWORD.trim()) return locked(res);
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const s = c.trim();
      const idx = s.indexOf('=');
      return idx === -1 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
    }),
  );
  if (cookies[COOKIE] === PASSWORD) return next();

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        res.setHeader('set-cookie', `${COOKIE}=${PASSWORD}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
        res.statusCode = 303; res.setHeader('location', req.url); return res.end();
      }
      res.statusCode = 401; res.setHeader('content-type', 'text/html'); res.setHeader('x-qda-gate', 'form'); res.end(page('Wrong password'));
    });
    return;
  }
  res.statusCode = 200; res.setHeader('content-type', 'text/html'); res.setHeader('x-qda-gate', 'form'); res.end(page());
};
