---
name: quick-dirty-auth
description: Use when the user wants to put a local app on the public web behind an auth gate quickly — "deploy this with a password", "put auth on this and ship it", "expose this app but lock it down", "quick dirty auth". Detects the app shape (Next.js, Node server, or static), applies a server-enforced gate (shared password by default; Cloudflare Access when the domain is already on Cloudflare), deploys to Vercel, and reports a live URL. Optimizes for hands-off operation. Also handles teardown.
---

# quick-dirty-auth

Deploy a local app to the web **with an auth gate**, as hands-off as possible. Vercel already makes deploy trivial; this skill fills the gap Vercel leaves — access control — and wires deploy + auth into one flow.

## When to use
The user has a local app (often one you just built/previewed) and wants it on the web, but not wide open. Default gate is a shared password. If their domain is already on Cloudflare, prefer Cloudflare Access (real email login, zero app code).

## Scripts (all in `scripts/`, run with `node`)
Run them from the **skill directory**, passing the target project path. They are unit-tested; trust their contracts.
- `detect.mjs` — app shape
- `probe-env.mjs` — route recommendation
- `gate-apply.mjs` — copy the right gate template into the project
- `cloudflare.mjs` — CF DNS + Access (needs `CF_API_TOKEN`)
- `manifest.mjs` — read/write `.qda.json`
- `password.mjs` — generate password

## Run flow

1. **Probe.** Detect the app shape (run `detect`). Determine `vercelAuthed` (`vercel whoami`), `cfTokenPresent` (`CF_API_TOKEN` set?), and — if a domain is in play — `domainOnCloudflare` (use `cloudflare.mjs findZone`). Compute the recommendation (`probe-env recommendRoute`).
2. **Recommend & confirm.** Tell the user the detected shape and the recommended route **with the reason**, in one message. Let them override. If shape is `unknown`, ask one disambiguating question first.
3. **One-time gates (only if unmet).**
   - If not `vercelAuthed`: ask the user to run `! vercel login` in their prompt (one-time; the only unavoidable human step). Wait, then continue.
   - If `cloudflare` route and Zero Trust was never enabled: tell the user the one-time dashboard step (enable Zero Trust, Free plan) and wait.
4. **Apply the gate.**
   - **password route:** generate a password (`password.mjs`), copy the gate template (`gate-apply.mjs`). For `node-server`, show the user the mount instruction. Record each written file in `.qda.json` (`manifest.mjs`). You will set `GATE_PASSWORD` as a Vercel env var in step 5.
   - **cloudflare route:** no app files. (DNS + Access happen after deploy, in step 5, once the Vercel target exists.)
5. **Deploy.**
   - Run `vercel --prod` (or `vercel` for a preview if the user asked). Capture the deployment URL.
   - **password route:** set the env var with `vercel env add GATE_PASSWORD production` (pipe the generated password), then redeploy so it takes effect. Record URL + credential in `.qda.json`.
   - **cloudflare route:** add the custom hostname (`vercel domains add` / alias to the deployment), then via `cloudflare.mjs`: `findAccountId()`, `upsertProxiedCname(zone, host, 'cname.vercel-dns.com')`, `createAccessApp`, `createAccessPolicy([userEmail])`. Record each resource (zone id, record id, app id, policy id) in `.qda.json` as you go.
6. **Report.** Print the live URL, the route used, and the credential:
   - password route → the URL + the password.
   - cloudflare route → the URL + "Login: email OTP, allowed = <emails>".
7. **Offer upgrade.** If you used the password route but `domainOnCloudflare` was true, tell the user they can re-run with `--access` for real email login.

## Teardown (`--teardown`)
Read `.qda.json` from the project. Reverse in order: remove the Vercel deployment/alias; if cloudflare route, delete the Access policy, Access app, and DNS record via `cloudflare.mjs`; delete any gate files the manifest says you created. Confirm what you'll remove before doing it.

## Failure handling
Check every external call. On failure, STOP and report the actual error — never half-finish silently. Because `.qda.json` is written incrementally, a partial setup is still tearable-down.

## Secrets
- Vercel token: from one-time `vercel login`.
- `CF_API_TOKEN` (cloudflare route only): scoped to DNS edit + Access edit.
