import { randomBytes } from 'node:crypto';

export function generatePassword(length = 24) {
  // base64url, trimmed to length
  return randomBytes(length).toString('base64url').slice(0, length);
}

export function renderPage(template, { error = '' } = {}) {
  return template.replaceAll('{{ERROR}}', error);
}

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export function loadPageTemplate() {
  return readFileSync(join(here, '..', 'templates', 'password-page.html'), 'utf8');
}

// CLI: node password.mjs [--length N]
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const flag = process.argv.indexOf('--length');
  const length = flag === -1 ? 24 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(length) || length < 1 || length > 128) {
    console.error('usage: node password.mjs [--length <1-128>]');
    process.exitCode = 1;
  } else {
    console.log(generatePassword(length));
  }
}
