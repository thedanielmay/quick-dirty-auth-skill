// templates/edge-middleware.ts → copied to a static project root as middleware.ts
// Vercel Edge Middleware for static sites. Dependency-free: no @vercel/edge import
// (bare static projects don't have it installed, and importing it 500s the runtime).
// Edge middleware can't reliably read a POST body for static sites, so the password
// is captured client-side: the form's inline JS sets the qda_auth cookie and reloads.
// The cookie is then verified SERVER-SIDE here against GATE_PASSWORD — content is never
// served without the correct cookie. Requires JavaScript in the browser (fine for previews).
const COOKIE = 'qda_auth';
const PASSWORD = process.env.GATE_PASSWORD ?? '';

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
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

export const config = { matcher: '/((?!favicon.ico).*)' };

export default function middleware(req: Request) {
  if (!PASSWORD) return; // gate disabled when unset → continue to content
  const cookie = req.headers.get('cookie') ?? '';
  const want = `${COOKIE}=${encodeURIComponent(PASSWORD)}`;
  if (cookie.split(';').some((c) => c.trim() === want)) return; // correct cookie → continue
  return page(); // no/incorrect cookie → show the form (sets cookie client-side, then reloads)
}
