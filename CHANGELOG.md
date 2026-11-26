# Changelog

## 1.2.0 - 2026-11-26

- The Cloudflare route checks the Access JWT inside the app, so a direct request to the Vercel host cannot bypass Cloudflare Access.
- Both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` must be set. One variable alone locks the site with 503 and `x-qda-gate: locked`. The password is ignored when Access is configured.
- Denied requests return 403 with `x-qda-gate: access`. The gate checks `alg` before key lookup, verifies RS256 with Web Crypto, and validates issuer, audience and time claims.
- Cert keys are cached per team, with one refetch when a `kid` is not cached. A fetch failure or a thrown error denies the request.
- Fastify hooks call `reply.hijack()` before ending the response. The Node 18 gates load Web Crypto from `node:crypto`.
- The Cloudflare client reads `auth_domain`, returns the app audience with a read-back fallback, adds every allowed email to the policy, and exposes the delete calls.
- The CNAME step reads existing DNS records first and refuses to overwrite a record this skill did not create.
- `cloudflare.mjs` gains a command line entry that runs from a path with a space and through a symlink.
- SKILL.md records the Access setup, preview checks, live URL checks and teardown of recorded IDs.

## 1.1.0 - 2026-11-26

- The password is never written to `.qda.json`. The manifest records only that a password is set, and removes any password field on read.
- `.qda.json` is added to the project `.gitignore` and `.vercelignore`, without duplicate lines.
- An existing gate file is never overwritten silently. With agreement, `--force` saves a backup next to the file. Teardown deletes only files this skill created and restores backups.
- Fastify apps get a dependency-free gate using an `onRequest` hook, with the same headers as the Express gate.
- Deploy stops when the server entry does not load and mount the gate before routes.
- Static signals outrank a stray server file. Conflicting static and server signals report `unknown`.
- Every gate reads `GATE_PASSWORD` when it handles a request. No health path is exempt.
- The scripts print results from the command line. Requires Node 22.18 or newer.

## 1.0.4 - 2026-11-26

- The gate stays locked with a 503 page until `GATE_PASSWORD` is set.
- Locked responses carry `x-qda-gate: locked`. Form and wrong-password responses carry `x-qda-gate: form`.
- Deploy checks read the `x-qda-gate` header on the preview and on the production domain.
- Update advised for sites published with 1.0.3 or earlier. Apply the gate again, redeploy, and remove old deployments.

## 1.0.3 - 2026-11-23

- Adds the marketplace icon approved by Daniel (thedanielmay/agent-tools#2).

## 1.0.2 - 2026-11-23

- Marketplace file gains a description, so the full check passes again (thedanielmay/agent-tools#10).

## 1.0.1 - 2026-11-22

- Added the marketplace files: marketplace.json, LICENSE, CHANGELOG.md and README.md.
- Added license and metadata.version to the SKILL.md frontmatter.
- Removed the email address from plugin.json and added the author url.
- Added .DS_Store, __pycache__/ and *.bak* to .gitignore.
