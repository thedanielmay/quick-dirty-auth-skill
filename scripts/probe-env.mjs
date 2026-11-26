export function recommendRoute({ cfTokenPresent = false, domainOnCloudflare = false, vercelAuthed = false } = {}) {
  const route = (cfTokenPresent && domainOnCloudflare) ? 'cloudflare' : 'password';
  const reason = route === 'cloudflare'
    ? 'Domain is on Cloudflare and a CF token is present — real per-email login (Cloudflare Access) is nearly hands-off.'
    : 'No Cloudflare domain/token detected — shared-password gate is the fully hands-off choice.';
  return { route, reason, needsVercelLogin: !vercelAuthed };
}

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function probeVercelAuthed() {
  try { execFileSync('vercel', ['whoami'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// CLI: node probe-env.mjs [--cf] [--domain-on-cf] [--vercel-authed]
// Flags describe the environment; the CLI never calls an external tool.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  const result = recommendRoute({
    cfTokenPresent: flags.includes('--cf'),
    domainOnCloudflare: flags.includes('--domain-on-cf'),
    vercelAuthed: flags.includes('--vercel-authed'),
  });
  console.log(`${result.route}: ${result.reason}`);
  console.log(`needsVercelLogin: ${result.needsVercelLogin}`);
}
