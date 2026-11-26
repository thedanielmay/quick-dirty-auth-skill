// qda-gate: quick-dirty-auth
// templates/express-gate.js → copied into a Node/Express project; mount directly after the app is created:
//   const gate = require('./qda-gate'); app.use(gate);
const COOKIE = 'qda_auth';
const LOCKED_TEXT = 'Locked: the site owner has not finished setting up the sign-in.';
// A sign-in request holds one short field.
const MAX_BODY = 4096;
// Redirect inside this site only. "//host" and "/\\host" point at another site.
const localPath = (url) => (/^\/(?![\/\\])[!-~]*$/.test(url ?? '') ? url : '/');

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

module.exports = function qdaGate(req, res, next) {
  // Read on each request so a password set after load still unlocks the site.
  const PASSWORD = process.env.GATE_PASSWORD || '';
  if (!PASSWORD.trim()) {
    res.statusCode = 503;
    res.setHeader('x-qda-gate', 'locked');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(LOCKED_TEXT);
    return;
  }
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
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) body += c; });
    req.on('end', () => {
      if (size > MAX_BODY) { res.statusCode = 413; res.setHeader('content-type', 'text/plain; charset=utf-8'); return res.end('Request too large'); }
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        res.setHeader('set-cookie', `${COOKIE}=${PASSWORD}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
        res.statusCode = 303; res.setHeader('location', localPath(req.url)); return res.end();
      }
      res.statusCode = 401; res.setHeader('content-type', 'text/html'); res.setHeader('x-qda-gate', 'form'); res.end(page('Wrong password'));
    });
    return;
  }
  res.statusCode = 200; res.setHeader('content-type', 'text/html'); res.setHeader('x-qda-gate', 'form'); res.end(page());
};
