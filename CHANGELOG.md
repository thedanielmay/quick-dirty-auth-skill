# Changelog

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
