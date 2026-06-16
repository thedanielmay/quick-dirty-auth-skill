import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, renderPage } from '../scripts/password.mjs';

test('generatePassword returns a url-safe string of requested length', () => {
  const p = generatePassword(24);
  assert.equal(p.length, 24);
  assert.match(p, /^[A-Za-z0-9_-]+$/);
});

test('generatePassword is non-deterministic', () => {
  assert.notEqual(generatePassword(24), generatePassword(24));
});

test('renderPage substitutes the error placeholder and is self-contained', () => {
  const html = renderPage('<!--TEMPLATE {{ERROR}} -->', { error: 'Wrong password' });
  assert.match(html, /Wrong password/);
  assert.doesNotMatch(html, /\{\{ERROR\}\}/);
});
