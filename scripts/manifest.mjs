export function emptyManifest(fields = {}) {
  return { version: 1, route: null, url: null, credential: null, resources: [], ...fields };
}
export function addResource(manifest, resource) {
  return { ...manifest, resources: [...manifest.resources, resource] };
}
export function mergeManifest(manifest, fields) {
  return { ...manifest, ...fields, resources: manifest.resources };
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function loadManifest(root) {
  const p = join(root, '.qda.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
export function saveManifest(root, manifest) {
  writeFileSync(join(root, '.qda.json'), JSON.stringify(manifest, null, 2) + '\n');
}
