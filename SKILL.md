---
name: quick-dirty-auth
description: Use when the user wants to put a local app on the public web behind an auth gate quickly — "deploy this with a password", "put auth on this and ship it", "expose this app but lock it down", "quick dirty auth". Detects the app shape (Next.js, Node server, or static), applies a server-enforced gate (shared password by default; Cloudflare Access when the domain is already on Cloudflare), deploys to Vercel, and reports a live URL. Optimizes for hands-off operation. Also handles teardown.
license: MIT
metadata:
  version: "1.0.4"
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
5. **Deploy.** Use the route-specific sequence below — do NOT deploy to production before the gate is active.
   - **password route:**
     1. Link the project: `vercel link --yes`. Set the password before any deploy, for both environments, with no trailing newline:
        - `printf '%s' "$PASSWORD" | vercel env add GATE_PASSWORD preview`
        - `printf '%s' "$PASSWORD" | vercel env add GATE_PASSWORD production`
        - If the variable already exists, replace it in both environments with `--force` after the user agrees. A stored value cannot be read back reliably, and the two environments can differ.
     2. Deploy a preview: `vercel`.
     3. Check the preview. Use `vercel curl`, which passes Vercel's own deployment protection. The CLI documents this at vercel.com/docs/cli/curl. The CLI can create a protection bypass secret on the project. Tell the user this and get their yes before the first `vercel curl`. Without a yes, create no new secret: the user opens the preview in their signed-in browser. Promote only when they report the sign-in form and that the password opens the site.
        - `vercel curl / --deployment <preview-url> -- -s -D - -o /dev/null` must show `x-qda-gate: form`.
        - Run the same command with `-H "Cookie: qda_auth=$PASSWORD"`. It must show status 200 and no `x-qda-gate` header. This proves the stored password is the one the user receives.
        - Generated passwords need no encoding. If the user chose the password and it has other characters, URL-encode it in the cookie for the static gate.
        - `x-qda-gate: locked` means the deployment has no password. Set the password and redeploy.
        - For any other result, stop. Show the user the status and headers. Do not promote.
     4. Promote: `vercel --prod`.
     5. Check the production domain that visitors use. Use the project domain or the alias that `vercel --prod` reports. Do not use the hashed deployment URL, which Vercel can protect. Run plain `curl -s -D - -o /dev/null https://<production-domain>`.
        - `x-qda-gate: form` means the gate answers. Then add `-H "Cookie: qda_auth=$PASSWORD"` to the same command. Status 200 with no `x-qda-gate` header means the password works: pass. If the form still shows, the stored production password differs: set it again and redeploy.
        - A redirect (status 3xx): run both checks on the address in the `location` header.
        - Without the cookie, status 200 with no `x-qda-gate` header means the site is open. Remove the deployment this run made: `vercel remove <deployment-url> --yes`. Then tell the user.
        - For any other result, do not report success. Show the user the status and headers.
   - After the checks pass, record the production URL and the credential in `.qda.json`.
   - **cloudflare route:** add the custom hostname (`vercel domains add` / alias to the deployment), then via `cloudflare.mjs`, in order: `const accountId = await findAccountId()`; `const recordId = await upsertProxiedCname(zoneId, host, 'cname.vercel-dns.com')` (zoneId from the step-1 `findZone`); `const appId = await createAccessApp(accountId, host)`; `await createAccessPolicy(accountId, appId, [userEmail])`. Record each resource (zone id, record id, app id, policy id) in `.qda.json` as you go.
6. **Report.** Print the live URL, the route used, and the credential:
   - password route → the URL + the password.
   - cloudflare route → the URL + "Login: email OTP, allowed = <emails>".
7. **Offer upgrade.** If you used the password route but `domainOnCloudflare` was true, tell the user they can re-run with `--access` for real email login.

## Already published with 1.0.3 or earlier

- Signs: `.qda.json` exists, and the gate file in the project has no `x-qda-gate`.
- Tell the user. Applying the gate again overwrites the gate file. Show any edits they made first, then ask.
- After the new gate is deployed, older deployments still hold the old gate at their own URLs. List them with `vercel ls`. Remove them only with the user's yes.

## Teardown (`--teardown`)
Read `.qda.json` from the project. Reverse in order: remove the Vercel deployment/alias; if cloudflare route, delete the Access policy, Access app, and DNS record via `cloudflare.mjs`; delete any gate files the manifest says you created. Confirm what you'll remove before doing it.

## Failure handling
Check every external call. On failure, STOP and report the actual error — never half-finish silently. Because `.qda.json` is written incrementally, a partial setup is still tearable-down.

## Secrets
- Vercel token: from one-time `vercel login`.
- `CF_API_TOKEN` (cloudflare route only): scoped to DNS edit + Access edit.
