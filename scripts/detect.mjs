// fs adapter: { readJson(path)->obj|null, readText(path)->string|null, exists(path)->bool }
export function detectShape(fs) {
  const pkg = fs.readJson('package.json');
  const dep = (name) =>
    pkg && ((pkg.dependencies && pkg.dependencies[name]) ||
            (pkg.devDependencies && pkg.devDependencies[name]));
  const readText = fs.readText ?? (() => null);

  const htmlPaths = ['index.html', 'public/index.html', 'dist/index.html',
                     'out/index.html', 'build/index.html'];
  const hasHtml = htmlPaths.some((p) => fs.exists(p));
  const nextExport = ['next.config.js', 'next.config.mjs', 'next.config.ts']
    .some((p) => /output\s*:\s*['"]export['"]/.test(readText(p) ?? ''));
  const vercel = fs.readJson('vercel.json');
  const vercelStatic = vercel && (
    typeof vercel.outputDirectory === 'string' ||
    (Array.isArray(vercel.builds) && vercel.builds.some((b) => /^@vercel\/static/.test(b?.use ?? '')))
  );
  const staticSignal = nextExport || Boolean(hasHtml && vercelStatic);
  const explicitServer = Boolean(dep('express') || dep('fastify'));
  const strayServer = ['server.js', 'server.mjs', 'server.ts'].some((f) => fs.exists(f));

  // A static build config or export beats a leftover server file. A real
  // server dependency alongside a static build is a conflict: ask the user.
  if (staticSignal) {
    if (explicitServer || (dep('next') && !nextExport)) {
      return { shape: 'unknown', reason: 'conflicting static and server signals' };
    }
    return { shape: 'static', reason: 'static build config or output export' };
  }

  if (dep('next')) return { shape: 'next', reason: 'next in package.json' };
  if (dep('fastify')) return { shape: 'fastify', reason: 'fastify in package.json' };
  if (explicitServer || strayServer)
    return { shape: 'node-server', reason: 'express/fastify dep or server.* file' };
  if (hasHtml)
    return { shape: 'static', reason: 'index.html with no server signal' };

  return { shape: 'unknown', reason: 'no recognizable app signal' };
}

// Real fs adapter for CLI use.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function nodeFsAdapter(root) {
  return {
    readJson: (p) => { try { return JSON.parse(readFileSync(join(root, p), 'utf8')); } catch { return null; } },
    readText: (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } },
    exists: (p) => existsSync(join(root, p)),
  };
}

// CLI: node detect.mjs <root>
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node detect.mjs <root>');
    process.exitCode = 1;
  } else {
    const result = detectShape(nodeFsAdapter(root));
    console.log(`${result.shape}: ${result.reason}`);
  }
}
