// templates/express-gate.js → copied into a Node/Express project; mount before routes:
//   const gate = require('./qda-gate'); app.use(gate);
const COOKIE = 'qda_auth';
const PASSWORD = process.env.GATE_PASSWORD || '';

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
  if (!PASSWORD) return next();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')));
  if (cookies[COOKIE] === PASSWORD) return next();

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        res.setHeader('set-cookie', `${COOKIE}=${PASSWORD}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
        res.statusCode = 303; res.setHeader('location', req.url); return res.end();
      }
      res.statusCode = 401; res.setHeader('content-type', 'text/html'); res.end(page('Wrong password'));
    });
    return;
  }
  res.statusCode = 200; res.setHeader('content-type', 'text/html'); res.end(page());
};
