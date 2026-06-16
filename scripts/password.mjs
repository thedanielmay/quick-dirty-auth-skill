import { randomBytes } from 'node:crypto';

export function generatePassword(length = 24) {
  // base64url, trimmed to length
  return randomBytes(length).toString('base64url').slice(0, length);
}

export function renderPage(template, { error = '' } = {}) {
  return template.replaceAll('{{ERROR}}', error);
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export function loadPageTemplate() {
  return readFileSync(join(here, '..', 'templates', 'password-page.html'), 'utf8');
}
