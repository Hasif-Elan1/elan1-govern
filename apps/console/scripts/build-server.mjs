/**
 * Builds the console's domain for the server: src/server/entry.ts bundled for Node into dist-server/domain.mjs
 * (imported by apps/web as `@gate/console/server`), and the operation manifest dist-server/ops.json. The bundle
 * carries the same manifest as its `opsManifest` export, so the server never runs operations against a manifest
 * from another build.
 *
 *   node scripts/build-server.mjs             build
 *   node scripts/build-server.mjs --if-stale  build only when a source file is newer than the output
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildManifest } from './op-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-server');
const BUNDLE = join(OUT, 'domain.mjs');
const MANIFEST = join(OUT, 'ops.json');

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

function stale() {
  try {
    const built = Math.min(statSync(BUNDLE).mtimeMs, statSync(MANIFEST).mtimeMs);
    const inputs = Math.max(newest(join(ROOT, 'src')), newest(join(ROOT, 'scripts')), statSync(join(ROOT, 'package.json')).mtimeMs, statSync(join(ROOT, 'tsconfig.json')).mtimeMs);
    return inputs > built;
  } catch {
    return true;
  }
}

export async function buildServer() {
  const manifest = buildManifest();
  mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, 'src/server/entry.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // every dependency the domain uses is bundled (@noble/*, yaml …); only Node's built-ins stay outside
    packages: 'bundle',
    alias: { '@': join(ROOT, 'src') },
    // browser globals bound to the shims inside the bundle, never installed on globalThis (src/server/shims.ts)
    inject: [join(ROOT, 'src/server/shims.ts')],
    // CommonJS dependencies (yaml) require Node built-ins; an ES module has no `require` of its own
    banner: { js: "import { createRequire as __egCreateRequire } from 'node:module';\nconst require = __egCreateRequire(import.meta.url);" },
    footer: { js: `export const opsManifest = ${JSON.stringify(manifest)};` },
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
  });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--if-stale') && !stale()) {
    console.log('dist-server is up to date');
  } else {
    const t = Date.now();
    const m = await buildServer();
    console.log(`dist-server/domain.mjs and ops.json (${m.ops.length} operations) in ${Date.now() - t} ms`);
  }
}
