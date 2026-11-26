---
name: quick-dirty-auth
description: 'Use when the user wants to put a local app on the public web behind a sign-in gate quickly: "deploy this with a password", "put auth on this and ship it", "expose this app but lock it down", "quick dirty auth". Detects the app shape (Next.js, Node server, Fastify, or static), applies a server-enforced gate (shared password by default; Cloudflare Access JWT check when the domain is already on Cloudflare), deploys to Vercel, and reports a live URL. Optimizes for hands-off operation. Also handles teardown.'
license: MIT
metadata:
  version: "1.2.0"
---

# quick-dirty-auth

Deploy a local app to the web **with an auth gate**, as hands-off as possible. Vercel already makes deploy trivial; this skill fills the gap Vercel leaves, access control, and wires deploy + auth into one flow.

## When to use
The user has a local app (often one you just built/previewed) and wants it on the web, but not wide open. Default gate is a shared password. If their domain is already on Cloudflare, prefer Cloudflare Access with the JWT check in the app (real email login, no app dependency).

## Scripts (all in `scripts/`, run with `node`)
Run them from the **skill directory**, passing the target project path. They are unit-tested; trust their contracts. Requires Node 22.18 or newer.
- `detect.mjs`: app shape
- `probe-env.mjs`: route recommendation
- `gate-apply.mjs`: copy the right gate template into the project
- `cloudflare.mjs`: CF DNS + Access (needs `CF_API_TOKEN`)
- `manifest.mjs`: read/write `.qda.json`, and record or forget an outside id (`record`, `forget`)
- `password.mjs`: generate password

## Run flow

1. **Probe.** Detect the app shape (run `detect`). Determine `vercelAuthed` (`vercel whoami`), `cfTokenPresent` (`CF_API_TOKEN` set?), and, if a domain is in play, `domainOnCloudflare` (use `cloudflare.mjs findZone`). Compute the recommendation (`probe-env recommendRoute`).
2. **Recommend & confirm.** Tell the user the detected shape and the recommended route **with the reason**, in one message. Let them override. If shape is `unknown`, ask one disambiguating question first.
3. **Prepare.**
   - If not `vercelAuthed`: ask the user to run `! vercel login` in their prompt (one-time; the only unavoidable human step). Wait, then continue.
   - If `cloudflare` route and Zero Trust was never enabled: tell the user the one-time dashboard step (enable Zero Trust, Free plan) and wait.
   - Every run: in the project, add `.qda.json` to `.gitignore` and `.vercelignore` (`manifest.mjs ignore`). Create a missing file. Do not add a duplicate line. Do this before any deploy.
4. **Apply the gate.**
   - **password route:**
     - Generate a password (`password.mjs`). Copy the gate template (`gate-apply.mjs`). For `node-server`, use `app.use(gate)`. For `fastify`, use `app.addHook('onRequest', gate)`. Show the user the mount instruction.
     - Verify the mount with `gate-apply.mjs verify <shape> <project>` before any deploy. The check passes only when the line that mounts the gate comes directly after the line that creates the app (only the line that loads `./qda-gate` can sit between them), so the gate runs before routes and everything else. The first `apply` on a server reports `mounted: false`, because the mount line is not there yet. In a Next.js project with pages only in `src/` (no root `app/` or `pages/`), `apply` writes `src/middleware.ts`. A file under `api/` passes only when it mounts the gate, or does nothing but export a file that mounts it. A project with `"type": "module"` cannot load `qda-gate.js`, so the check fails there: do not deploy it. If it fails, move the gate line there, with the user's yes, and run the check again. Do not deploy while it fails. The check is a helper that reads the usual entry files. It is not proof. Also read the server code yourself, and tell the user about any route or server that can answer without the gate. If a second file creates the running app and the check did not read it, do not rely on a pass.
     - Never overwrite a file silently. If a destination exists and is not a gate this skill wrote, stop with a clear message and show the file. A `--force` option exists only after the user agrees. It saves a backup copy next to the file. A gate that differs from the current one is replaced, and a copy of it is kept next to the file.
     - Record each written file and a password-set flag in `.qda.json` (`manifest.mjs`). Never record the password value.
     - You will set `GATE_PASSWORD` as a Vercel env var in step 5.
   - **cloudflare route:** copy the right gate template with `gate-apply.mjs apply <shape> <project>`. It is the same template as the password route. For `node-server` and `fastify`, mount it and pass `gate-apply.mjs verify <shape> <project>` exactly as the password route says, before any deploy. The app checks the `Cf-Access-Jwt-Assertion` header itself on each request. No npm dependency is added. Keep Vercel Standard Protection as an extra layer if the project already uses it. Do not turn on all-deployment Vercel Authentication: it would block allowed visitors who are not on the Vercel team.
     - Both Access variables set: JWT check only, and the password is ignored.
     - Only one set: 503 with `x-qda-gate: locked`.
     - No Access variables and a password set: the current password gate.
     - Nothing set: 503 locked. No path is exempt.
5. **Deploy.** Use the route-specific sequence below. Do NOT deploy to production before the gate is active. Do not deploy at all until the mount check above passes. The `x-qda-gate` checks below are the proof that the gate runs in the deployment.
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
        - A redirect (status 3xx): run both checks on the address in the `location` header.
        - For any other result, stop. Show the user the status and headers. Do not promote.
     4. Promote: `vercel --prod`.
     5. Check the production domain that visitors use. Use the project domain or the alias that `vercel --prod` reports. Do not use the hashed deployment URL, which Vercel can protect. Run plain `curl -s -D - -o /dev/null https://<production-domain>`. To send the password, pass the header on standard input, so it does not show in the process list: `printf 'header = "Cookie: qda_auth=%s"\n' "$PASSWORD" | curl -K - ...`.
        - `x-qda-gate: form` means the gate answers. Then run the same command with the password header on standard input. Status 200 with no `x-qda-gate` header means the password works: pass. If the form still shows, the stored production password differs: set it again and redeploy.
        - A redirect (status 3xx): run both checks on the address in the `location` header.
        - Without the cookie, status 200 with no `x-qda-gate` header means the site is open. Remove the deployment this run made: `vercel remove <deployment-url> --yes`. Then tell the user.
        - For any other result, do not report success. Show the user the status and headers.
   - After the checks pass, record the production URL and a password-set flag in `.qda.json`. Never record the password value.
   - **cloudflare route:** follow the Cloudflare route below in order. Do not publish the custom host until the gate checks pass.
6. **Report.** Print the live URL, the route used, and the credential:
   - password route → the URL + the password. Show the password once, in chat.
   - cloudflare route → the URL + "Login: email OTP, allowed = <emails>".
7. **Offer upgrade.** If you used the password route but `domainOnCloudflare` was true, tell the user they can re-run with `--access` for real email login.

### Cloudflare route

The app checks the Cloudflare Access JWT itself on every request, on every host that reaches the deployment. Vercel Standard Protection stays only as an extra layer. All-deployment Vercel Authentication would block allowed visitors who are not on the Vercel team.

Record each outside id with `manifest.mjs record <project> '<json>'`. Each record is one JSON object with a text `kind` and a text `id`. The kind `file` is not allowed here: `gate-apply.mjs` writes the file records. `gate-apply.mjs teardown` keeps these records, so they stay in `.qda.json` until each delete succeeds.

1. **Ask for the hostname and the allowed emails.** The hostname must sit inside the found zone from step 1. Ask the user for every email that may sign in.
2. **Get the account and team domain.** Use `cloudflare.mjs find-account`. If more than one account exists, ask the user which one to use and pass the chosen id. Then use `cloudflare.mjs auth-domain <accountId>` for `auth_domain`. If it fails, give the one-time Zero Trust step (enable Zero Trust, Free plan) and wait.
3. **Apply the gate template.** Copy it with `gate-apply.mjs apply <shape> <project>`, which records the written file in `.qda.json`. For `node-server` and `fastify`, mount the gate and pass `gate-apply.mjs verify <shape> <project>`, as in the password route, before any deploy. The template reads `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` at request time. It reads the `Cf-Access-Jwt-Assertion` header and denies with 403 and `x-qda-gate: access` unless every check passes:
   - `alg` is `RS256`, checked before any key lookup. A `none` or `HS256` token never reaches the cert endpoint.
   - `kid` is in `https://<team>/cdn-cgi/access/certs`. Keys are cached, with one refetch for an unknown `kid`.
   - Web Crypto verifies `RSASSA-PKCS1-v1_5` with SHA-256.
   - `iss` equals `https://<team>`; the team variable works with or without the scheme.
   - `aud`, a string or an array, contains `CF_ACCESS_AUD`.
   - `exp` is in the future and `nbf` is not.
   - Any fetch failure or thrown error denies. Express catches async errors and ends the response. Fastify uses `addHook('onRequest', ...)` over `req.raw` and `reply.raw`, and calls `reply.hijack()` before the gate ends the response. Node 18 gates load Web Crypto from `require('node:crypto').webcrypto`.
   - With only one of the two Access variables set, lock with 503 and `x-qda-gate: locked`. No path is exempt. The password is ignored when Access is configured.
4. **Create the Access app and the policy.** Use `cloudflare.mjs create-app <accountId> <host>`. It returns the app id and `aud`; a missing `aud` on create is read back with `GET .../apps/{id}`. Record the app at once: `manifest.mjs record <project> '{"kind":"cloudflare-access-app","id":"<appId>","accountId":"<accountId>","aud":"<aud>"}'`. Then use `cloudflare.mjs create-policy <accountId> <appId> <email...>` with every allowed email and record the policy: `'{"kind":"cloudflare-access-policy","id":"<policyId>","appId":"<appId>","accountId":"<accountId>"}'`. Run `manifest.mjs read <project>` and check that both records are there.
5. **Link and set variables.** Run `vercel link`. Set `CF_ACCESS_TEAM_DOMAIN` to the team domain and `CF_ACCESS_AUD` to the returned `aud`, for preview and production.
6. **Deploy a preview.** Run `vercel`. The preview address is a `vercel.app` URL, so it shows the 403 access text with `x-qda-gate: access`, not the Access sign-in page. With the user's yes, confirm this with `vercel curl` on the preview. Without a yes, the user opens the preview in their browser and sees the same 403 text. The Access sign-in page appears only on the custom host after step 8.
7. **Promote and add the host.** Run `vercel --prod`, then `vercel domains add <host>`, then `cloudflare.mjs upsert-cname <zoneId> <host> cname.vercel-dns.com` with the zone id from step 1. The command prints `{ "id": "...", "created": true/false }`. Record the DNS record id only when `created` is true: `'{"kind":"cloudflare-dns","id":"<recordId>","zoneId":"<zoneId>"}'`. When `vercel domains add` adds the host, record it as `'{"kind":"vercel-domain","id":"<host>"}'`. A result of `created: false` means the record already existed, so leave it out of `.qda.json` and keep it out of teardown. The client reads existing records first, refuses a record that is not proxied, and never overwrites a record this skill did not create. The host is never public until the checks in step 8 pass.
8. **Check the live gate.**
   - `https://<host>` redirects (302) to `<team>.cloudflareaccess.com`.
   - `curl --connect-to <host>:443:cname.vercel-dns.com:443 https://<host>/` returns 403 with `x-qda-gate: access`.
   - Plain curl on `<project>.vercel.app` returns 403 `access` or a Vercel 401, never 200.
   - `vercel curl` on the hashed preview URL returns 403 with `x-qda-gate: access`.
   - The user signs in with an allowed email and sees the app.
   - A redirect (status 3xx): follow the `location` header and repeat the check on that address.
9. **Report the emails.** Read back from the policy response every allowed email and tell the user the list.
10. **Teardown deletes only recorded IDs:** the DNS record this skill created, the policy, the app, the Vercel domain, both Access variables and the gate files. A DNS record with `created: false` is never recorded. After each delete succeeds, run `manifest.mjs forget <project> <kind> <id>` for that record. Confirm the removal list before doing it.

## Already published with 1.0.3 or earlier

- Signs: `.qda.json` exists, and the gate file in the project has no `x-qda-gate`.
- Tell the user. Applying the gate again stops if the file is not a gate this skill wrote. Show any edits they made first, then ask before using `--force`, which saves a backup.
- If `.qda.json` was ever committed, run `git rm --cached .qda.json`. The password is in the git history. Tell the user and change the password.
- After the new gate is deployed, older deployments still hold the old gate at their own URLs. List them with `vercel ls`. Remove them only with the user's yes. A deployment that stays up keeps the old gate. Tell the user that.

## Teardown (`--teardown`)
Read `.qda.json` from the project. Reverse in order: remove the Vercel deployment/alias; if cloudflare route, delete the recorded Access policy with `cloudflare.mjs delete-policy`, the Access app with `delete-app`, and the DNS record only records it created with `delete-dns`; then remove the Vercel domain and the Access variables; after each delete succeeds, run `manifest.mjs forget <project> <kind> <id>`, so a failed delete keeps its record for the next run; delete any gate files the manifest says this skill created, and restore any backup the manifest records. Leave files this skill did not create in place. Confirm the removal list before doing it. The script keeps a file that changed after apply, and reports it.

## Failure handling
Check every external call. On failure, STOP and report the actual error, never half-finish silently. Because `.qda.json` is written incrementally, a partial setup is still tearable-down.

## Secrets
- Vercel token: from one-time `vercel login`.
- `CF_API_TOKEN` (cloudflare route only): scoped to DNS edit + Access edit.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (cloudflare route): set for preview and production. The app reads both at request time.
- Password route: a host health check sees 503 until `GATE_PASSWORD` is set. No path is exempt. Set the password before any deploy.
- Cloudflare route: a host health check sees 503 until both Access variables are set, then 403 `access` without a valid token. No path is exempt.
