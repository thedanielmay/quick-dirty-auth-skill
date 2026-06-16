export function recommendRoute({ cfTokenPresent = false, domainOnCloudflare = false, vercelAuthed = false } = {}) {
  const route = (cfTokenPresent && domainOnCloudflare) ? 'cloudflare' : 'password';
  const reason = route === 'cloudflare'
    ? 'Domain is on Cloudflare and a CF token is present — real per-email login (Cloudflare Access) is nearly hands-off.'
    : 'No Cloudflare domain/token detected — shared-password gate is the fully hands-off choice.';
  return { route, reason, needsVercelLogin: !vercelAuthed };
}

import { execFileSync } from 'node:child_process';
export function probeVercelAuthed() {
  try { execFileSync('vercel', ['whoami'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}
