// fs adapter: { readJson(path)->obj|null, exists(path)->bool }
export function detectShape(fs) {
  const pkg = fs.readJson('package.json');
  const dep = (name) =>
    pkg && ((pkg.dependencies && pkg.dependencies[name]) ||
            (pkg.devDependencies && pkg.devDependencies[name]));

  if (dep('next')) return { shape: 'next', reason: 'next in package.json' };

  const serverFiles = ['server.js', 'server.mjs', 'server.ts'];
  if (dep('express') || dep('fastify') || serverFiles.some((f) => fs.exists(f)))
    return { shape: 'node-server', reason: 'express/fastify dep or server.* file' };

  const htmlPaths = ['index.html', 'public/index.html', 'dist/index.html',
                     'out/index.html', 'build/index.html'];
  if (htmlPaths.some((p) => fs.exists(p)))
    return { shape: 'static', reason: 'index.html with no server signal' };

  return { shape: 'unknown', reason: 'no recognizable app signal' };
}

// Real fs adapter for CLI use.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function nodeFsAdapter(root) {
  return {
    readJson: (p) => { try { return JSON.parse(readFileSync(join(root, p), 'utf8')); } catch { return null; } },
    exists: (p) => existsSync(join(root, p)),
  };
}
