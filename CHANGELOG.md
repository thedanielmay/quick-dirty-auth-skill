# Changelog

## 1.3.1 - 2026-11-26

- `verify` allows a `.gitkeep` in `public/` only when it is empty.

## 1.3.0 - 2026-11-26

- `verify` refuses a `node-server` project with files in `public/`. `.DS_Store` and `.gitkeep` do not count. Serve those files through the app from another folder after the gate.
- `verify` refuses `.py`, `.go` and `.rb` files under `api/` on `node-server` and `fastify`.
- `verify` also reads the files that the start script and `main` name, with or without an extension, and `.mts` and `.cts` entry files. An app without the gate in one of them is refused.
- When one file causes a refusal, `verify` prints its name.
- Teardown names the ignore files that still hold the `.qda.json` line, and leaves the line in place.

## 1.2.0 - 2026-11-26

- The Cloudflare route checks the Cloudflare Access JWT inside the app on every request, with the same gate templates as the password route.
- Both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` must be set. One variable alone locks the site with 503 and `x-qda-gate: locked`. The password is ignored when Access is configured.
- Denied requests return 403 with `x-qda-gate: access`. The gate checks `alg` before key lookup, verifies RS256 with Web Crypto, and validates issuer, audience and time claims.
- Cert keys are cached per team, with one refetch when a `kid` is not cached. A thrown error denies the request. A failed or slow certificate fetch denies it when no cached key is usable.
- Fastify hooks call `reply.hijack()` before ending the response. The Node 18 gates load Web Crypto from `node:crypto`.
- The Cloudflare client reads `auth_domain`, returns the app audience with a read-back fallback, adds every allowed email to the policy, and exposes the delete calls.
- The CNAME step reads existing DNS records first and refuses to overwrite a record this skill did not create.
- `cloudflare.mjs` gains a command line entry that runs from a path with a space and through a symlink.
- SKILL.md records the Access setup, preview checks, live URL checks and teardown of recorded IDs.
- `cloudflare.mjs check-cname` reads the hostname before the Access app is created. `create-policy` refuses an empty email list and prints the saved emails.
- `manifest.mjs record` and `manifest.mjs forget` keep each Cloudflare id and the Vercel domain in `.qda.json` until its delete succeeds.

## 1.1.0 - 2026-11-26

- The password is never written to `.qda.json`. The manifest keeps a flag that a password is set, and removes any password field on read.
- `.qda.json` is added to the project `.gitignore` and `.vercelignore`, without duplicate lines.
- A user file is overwritten only with `--force`, which saves a backup. A changed or older gate is copied before it is replaced. Teardown deletes only unchanged files this skill created, restores backups, keeps other records, and refuses records for other files.
- Fastify apps get a dependency-free gate using an `onRequest` hook, with the same headers as the Express gate.
- Deploy stops when the server entry does not load and mount the gate before routes, when a file under `api/` can answer alone, or or when the gate file is not in the folder Next.js reads. A Next.js project with pages only in `src/` gets `src/middleware.ts`.
- Static signals outrank a stray server file. Conflicting static and server signals report `unknown`.
- Every gate reads `GATE_PASSWORD` when it handles a request. No health path is exempt.
- The detect, probe, record, password and gate scripts print results from the command line. Requires Node 22.18 or newer.
- The Express and Fastify gates limit the size of a sign-in request.
- After sign-in, the Express and Fastify gates redirect only within the same site.
- The scripts refuse a symbolic link and a folder outside the project.
- The static gate covers every path. The Next.js gate covers every path except built assets and image resizing.

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
