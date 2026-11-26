// qda-gate: quick-dirty-auth
// templates/edge-middleware.ts → copied to a static project root as middleware.ts
// Vercel Edge Middleware for static sites. Dependency-free: no @vercel/edge import
// (bare static projects do not have it installed, and importing it 500s the runtime).
// Edge middleware cannot reliably read a POST body for static sites, so the password
// is captured client-side: the form's inline JS sets the qda_auth cookie and reloads.
// The cookie is then verified SERVER-SIDE here against GATE_PASSWORD. Content is never
// served without the correct cookie. Requires JavaScript in the browser (fine for previews).
const COOKIE = 'qda_auth';
const DENIED_TEXT = 'Access denied: Cloudflare Access did not authorise this request.';
const certCache = new Map();
const REFRESH_MS = 60 * 60 * 1000;
const REFETCH_MS = 60 * 1000;

async function fetchKeys(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('certificate fetch failed');
  const data = await response.json();
  if (!Array.isArray(data?.keys)) throw new Error('certificate keys missing');
  return data.keys;
}

async function cachedKeys(url: string, kid: string) {
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

const page = () => new Response(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Protected</title>
  <style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#eee}
  form{display:grid;gap:12px;width:min(320px,90vw)}input,button{padding:12px;border-radius:8px;font-size:16px}
  input{border:1px solid #333;background:#161618;color:#eee}button{border:0;background:#3b82f6;color:#fff;cursor:pointer}
  .err{color:#f87171;min-height:1.2em;font-size:14px}</style>
  <form id=qdaform><div class=err id=qdaerr></div>
  <input id=qdapw type=password placeholder=Password autofocus required>
  <button>Enter</button></form>
  <script>
  document.getElementById('qdaform').addEventListener('submit',function(ev){
    ev.preventDefault();
    var v=document.getElementById('qdapw').value;
    document.cookie='${COOKIE}='+encodeURIComponent(v)+'; Path=/; Max-Age=604800; SameSite=Lax; Secure';
    location.reload();
  });
  </script>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-qda-gate': 'form' } },
);

const locked = () => new Response(
  'Locked: the site owner has not finished setting up the sign-in.',
  {
    status: 503,
    headers: {
      'x-qda-gate': 'locked',
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  },
);

const denied = () => new Response(DENIED_TEXT, {
  status: 403,
  headers: {
    'x-qda-gate': 'access',
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  },
});

const teamName = (raw: string | undefined) => String(raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const bytes = (part: string) => {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json = (part: string) => JSON.parse(new TextDecoder().decode(bytes(part)));

async function verifyAccess(jwt: string | null, team: string, aud: string): Promise<boolean> {
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
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify'],
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, bytes(parts[2]), signed);
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

export const config = { matcher: '/((?!favicon\\.ico$).*)' };

export default async function middleware(req: Request) {
  // Read the environment on each request. A setup change needs no redeploy.
  const team = teamName(process.env.CF_ACCESS_TEAM_DOMAIN);
  const aud = String(process.env.CF_ACCESS_AUD ?? '').trim();
  const hasTeam = Boolean(team);
  const hasAud = Boolean(aud);
  if (hasTeam !== hasAud) return locked();
  if (hasTeam && hasAud) {
    const ok = await verifyAccess(req.headers.get('cf-access-jwt-assertion'), team, aud);
    return ok ? undefined : denied();
  }

  const PASSWORD = process.env.GATE_PASSWORD ?? '';
  if (!PASSWORD.trim()) return locked();
  const cookie = req.headers.get('cookie') ?? '';
  const want = `${COOKIE}=${encodeURIComponent(PASSWORD)}`;
  if (cookie.split(';').some((c) => c.trim() === want)) return; // correct cookie → continue
  return page(); // no/incorrect cookie → show the form (sets cookie client-side, then reloads)
}
