# quick-dirty-auth

Deploys a local app to the public web behind an auth gate, with as little hand work as possible. It detects the app type (Next.js, Node server or static site), adds a server-enforced gate, deploys to Vercel and reports the live URL. The gate is a shared password by default. It is Cloudflare Access when the domain is already on Cloudflare. The skill also handles teardown.

## When to use

Use it when you have a local app and want it on the web, but not open to everyone.

## Install

Install as a plugin:

```
/plugin install quick-dirty-auth --marketplace thedanielmay/quick-dirty-auth-skill
```

Or link the folder into your skills directory:

```
ln -s /path/to/quick-dirty-auth-skill ~/.claude/skills/quick-dirty-auth
```

The scripts run with Node, and the deploy goes to Vercel.

## Changes

See [CHANGELOG.md](CHANGELOG.md).
