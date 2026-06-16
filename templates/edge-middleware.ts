// templates/edge-middleware.ts → copied to a static project root as middleware.ts
// Vercel Edge Middleware; gates static assets the same way.
import { next } from '@vercel/edge';

const COOKIE = 'qda_auth';
const PASSWORD = process.env.GATE_PASSWORD ?? '';

const html = (error = '', status = 200) => new Response(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Protected</title>
  <style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#eee}
  form{display:grid;gap:12px;width:min(320px,90vw)}input,button{padding:12px;border-radius:8px;font-size:16px}
  input{border:1px solid #333;background:#161618;color:#eee}button{border:0;background:#3b82f6;color:#fff;cursor:pointer}
  .err{color:#f87171;min-height:1.2em;font-size:14px}</style>
  <form method=POST><div class=err>${error}</div>
  <input type=password name=password placeholder=Password autofocus required>
  <button>Enter</button></form>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

export const config = { matcher: '/((?!favicon.ico).*)' };

export default async function middleware(req: Request) {
  if (!PASSWORD) return next();
  const cookie = req.headers.get('cookie') ?? '';
  if (cookie.split(';').some((c) => c.trim() === `${COOKIE}=${PASSWORD}`)) return next();

  if (req.method === 'POST') {
    const form = await req.formData();
    if (form.get('password') === PASSWORD) {
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(req.url).pathname,
          'set-cookie': `${COOKIE}=${PASSWORD}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
        },
      });
    }
    return html('Wrong password', 401);
  }
  return html();
}
