// templates/next-middleware.ts  → copied to target project root as middleware.ts
import { NextRequest, NextResponse } from 'next/server';

const COOKIE = 'qda_auth';
const PASSWORD = process.env.GATE_PASSWORD ?? '';

const page = (error = '') => new NextResponse(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Protected</title>
  <style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#eee}
  form{display:grid;gap:12px;width:min(320px,90vw)}input,button{padding:12px;border-radius:8px;font-size:16px}
  input{border:1px solid #333;background:#161618;color:#eee}button{border:0;background:#3b82f6;color:#fff;cursor:pointer}
  .err{color:#f87171;min-height:1.2em;font-size:14px}</style>
  <form method=POST><div class=err>${error}</div>
  <input type=password name=password placeholder=Password autofocus required>
  <button>Enter</button></form>`,
  { status: error ? 401 : 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

export async function middleware(req: NextRequest) {
  if (!PASSWORD) return NextResponse.next(); // gate disabled if unset
  if (req.cookies.get(COOKIE)?.value === PASSWORD) return NextResponse.next();

  if (req.method === 'POST') {
    const form = await req.formData();
    if (form.get('password') === PASSWORD) {
      const res = NextResponse.redirect(new URL(req.url));
      res.cookies.set(COOKIE, PASSWORD, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 24 * 7 });
      return res;
    }
    return page('Wrong password');
  }
  return page();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
