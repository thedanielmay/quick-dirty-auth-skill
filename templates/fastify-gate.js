// qda-gate: quick-dirty-auth
// templates/fastify-gate.js → copied into a Fastify project; register before routes:
//   const gate = require('./qda-gate'); app.addHook('onRequest', gate);
const COOKIE = 'qda_auth';
const LOCKED_TEXT = 'Locked: the site owner has not finished setting up the sign-in.';

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

module.exports = function qdaGate(request, reply, done) {
  // Read the password on each request so env vars set after load still work.
  const PASSWORD = process.env.GATE_PASSWORD || '';
  if (!PASSWORD.trim()) {
    reply.code(503);
    reply.header('x-qda-gate', 'locked');
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.send(LOCKED_TEXT);
    return;
  }
  const cookies = Object.fromEntries(
    (request.headers.cookie || '').split(';').map((c) => {
      const s = c.trim();
      const idx = s.indexOf('=');
      return idx === -1 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
    }),
  );
  if (cookies[COOKIE] === PASSWORD) return done();

  if (request.method === 'POST') {
    // onRequest runs before Fastify parses the body, so read the raw stream.
    let body = '';
    const raw = request.raw ?? request;
    raw.on('data', (c) => (body += c));
    raw.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        reply.code(303);
        reply.header('set-cookie', `${COOKIE}=${PASSWORD}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
        reply.header('location', request.url ?? '/');
        return reply.send();
      }
      reply.code(401);
      reply.header('content-type', 'text/html');
      reply.header('x-qda-gate', 'form');
      reply.send(page('Wrong password'));
    });
    return;
  }
  reply.code(200);
  reply.header('content-type', 'text/html');
  reply.header('x-qda-gate', 'form');
  reply.send(page());
};
