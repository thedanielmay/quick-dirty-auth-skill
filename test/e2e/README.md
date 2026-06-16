# End-to-end smoke tests

These verify each gate template actually enforces auth, locally, **without deploying**.
They are a manual runbook, not part of `node --test`. Run them after changing any
gate template (`templates/*.ts`, `templates/*.js`) or `scripts/gate-apply.mjs`.

All three only touch `/tmp` and local ports — nothing outward-facing.

Behavioral contract verified by these tests (per gate):
- **No / wrong cookie** → the password form is served; the protected content is NEVER served.
- **Correct credential** → a `qda_auth` cookie is established; protected content becomes reachable.

Status-code note: the form is returned with HTTP **200** by the Express and static gates,
and with **401** by the Next gate. A 200 here is correct — it's the login page, not a leak.
Always assert on the BODY (form present, app content absent), not the status code alone.

---

## 1. Express / Node server  (template: express-gate.js)

```bash
SKILL=~/projects/quick-dirty-auth-skill
cd /tmp && rm -rf qda-node && mkdir qda-node && cd qda-node
npm init -y >/dev/null && npm i express >/dev/null
node "$SKILL/scripts/gate-apply.mjs" node-server /tmp/qda-node
cat > server.js <<'EOF'
const express = require('express'); const gate = require('./qda-gate');
const app = express(); app.use(gate);
app.get('/', (_req, res) => res.send('secret content')); app.listen(3002);
EOF
GATE_PASSWORD=test123 node server.js & SRV=$!; sleep 2
curl -s localhost:3002 | grep -qi 'type=password' && echo 'no-cookie: form ✓'
curl -s localhost:3002 | grep -qi 'secret content' && echo 'LEAK ✗' || echo 'no leak ✓'
curl -s -o /dev/null -w 'wrong-pw status=%{http_code}\n' -X POST --data 'password=nope' localhost:3002   # 401
curl -s -i -X POST --data 'password=test123' localhost:3002 | grep -i set-cookie                          # qda_auth set
curl -s --cookie 'qda_auth=test123' localhost:3002 | grep -qi 'secret content' && echo 'cookie reaches content ✓'
kill $SRV
```

## 2. Next.js  (template: next-middleware.ts)

```bash
SKILL=~/projects/quick-dirty-auth-skill
cd /tmp && rm -rf qda-next
npx --yes create-next-app@latest qda-next --ts --no-eslint --app --no-tailwind --no-src-dir --import-alias '@/*' --use-npm
node "$SKILL/scripts/gate-apply.mjs" next /tmp/qda-next
cd qda-next && GATE_PASSWORD=test123 npm run dev & SRV=$!
# wait for ready, then:
curl -s localhost:3000 | grep -qi 'type=password' && echo 'no-cookie: form ✓'
curl -s localhost:3000 | grep -qi 'Get started' && echo 'LEAK ✗' || echo 'no leak ✓'
curl -s -o /dev/null -w 'wrong-pw status=%{http_code}\n' -X POST --data 'password=nope' localhost:3000   # 401
curl -s -i -X POST --data 'password=test123' localhost:3000 | grep -i set-cookie                          # qda_auth set (307 redirect)
curl -s --cookie 'qda_auth=test123' localhost:3000 | grep -qi 'Get started' && echo 'cookie reaches app ✓'
kill $SRV; pkill -f 'next dev'
```

## 3. Static  (template: edge-middleware.ts, dependency-free, client-side cookie)

Requires the Vercel CLI authed. In non-interactive use you must pass `--scope <team>`
(the CLI prints the team list if you omit it). The skill's `gate-apply.mjs` also writes
a minimal `package.json` so the edge runtime can resolve the middleware.

```bash
SKILL=~/projects/quick-dirty-auth-skill
cd /tmp && rm -rf qda-static && mkdir qda-static && cd qda-static
echo '<h1>secret static content</h1>' > index.html
node "$SKILL/scripts/gate-apply.mjs" static /tmp/qda-static     # writes middleware.ts + package.json
vercel link --yes --scope <your-team>
GATE_PASSWORD=test123 vercel dev --listen 3003 --yes --scope <your-team> & SRV=$!
# wait for ready, then:
curl -s localhost:3003 | grep -qi 'type=password' && echo 'no-cookie: form ✓'
curl -s localhost:3003 | grep -qi 'secret static content' && echo 'LEAK ✗' || echo 'no leak ✓'
curl -s --cookie 'qda_auth=wrong'   localhost:3003 | grep -qi 'secret static content' && echo 'LEAK ✗' || echo 'wrong cookie blocked ✓'
curl -s --cookie 'qda_auth=test123' localhost:3003 | grep -qi 'secret static content' && echo 'correct cookie reaches content ✓'
kill $SRV; pkill -f 'vercel dev'
```

The static gate captures the password client-side (inline JS sets the cookie, then
reloads) because edge middleware can't read a POST body for static sites. The cookie
is still verified server-side. Requires JavaScript in the browser — acceptable for previews.

---

## Last verified

All three flows passed locally on 2026-06-16 (Node 26, vercel CLI 54). The static flow
caught and fixed a real defect: the original `@vercel/edge` import 500'd on bare static
projects (see commit "fix: static gate is dependency-free ...").
