# Changelog

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
