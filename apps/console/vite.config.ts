import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { livePlan, transformModule } from './scripts/live-transform.mjs';

/**
 * Where the data comes from (src/api/mode.ts): VITE_DATA=live (the default, for `vite build` and `pnpm dev:console`)
 * runs the console on the real backend through the same origin; VITE_DATA=mock is the approved demonstration,
 * standalone, exactly as built.
 */
const DATA = (process.env.VITE_DATA ?? 'live').trim().toLowerCase();
if (DATA !== 'live' && DATA !== 'mock') throw new Error(`VITE_DATA must be "live" or "mock", not "${process.env.VITE_DATA}".`);
const LIVE = DATA === 'live';

/** The Next.js app that serves the API (and, built, this console). Development only: Vite proxies /api to it. */
const API = process.env.CONSOLE_API_URL ?? process.env.WEB_URL ?? 'http://localhost:3000';

/**
 * Written into every script and stylesheet tag of a live build's index.html; the Next.js route that serves the
 * console (apps/web/src/app/console-shell/route.ts) replaces it with the request's CSP nonce.
 */
export const CSP_NONCE_PLACEHOLDER = '__GOVERN_CSP_NONCE__';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Third-party code goes into its own long-lived chunks so the app chunk stays small and caches separately.
const VENDOR_CHUNKS: [string, RegExp][] = [
  ['react', /node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run|scheduler)[\\/]/],
  ['codemirror', /node_modules[\\/](@codemirror|@uiw|@lezer|style-mod|w3c-keyname|crelt)[\\/]/],
  ['charts', /node_modules[\\/](recharts|recharts-scale|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light|react-smooth|eventemitter3|lodash)[\\/]/],
  ['crypto', /node_modules[\\/]@noble[\\/]/],
  ['yaml', /node_modules[\\/]yaml[\\/]/],
  ['icons', /node_modules[\\/]lucide-react[\\/]/],
  ['vendor', /node_modules[\\/]/],
];

/**
 * Writes sw-assets.json next to index.html: every built script, stylesheet and font, with a version digest.
 * The service worker (public/sw.js) caches them on install, so the console — including the /offline screen —
 * opens with no network. Built file names are content-hashed, so a cached copy is never stale.
 */
function swAssetList(): Plugin {
  return {
    name: 'eg-sw-asset-list',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => /\.(js|css|woff2?|svg|png)$/.test(f) && f.startsWith('assets/')).sort().map((f) => `/${f}`);
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw-assets.json', source: JSON.stringify({ version, files }) });
    },
  };
}

/**
 * Live builds: every operation the server's RPC door runs is rewritten to go through `__live.call`
 * (scripts/live-transform.mjs, from the server's own operation manifest), so it can be sent to the server.
 */
function liveOperations(): Plugin {
  let plan: Awaited<ReturnType<typeof livePlan>>['plan'] | undefined;
  return {
    name: 'eg-live-operations',
    enforce: 'pre',
    async buildStart() {
      plan = (await livePlan(ROOT)).plan;
    },
    transform(code, id) {
      const file = id.split('?')[0];
      const p = plan?.get(file);
      if (!p) return undefined;
      return { code: transformModule(code, p, file), map: null };
    },
  };
}

export default defineConfig(({ command }) => ({
  // JSX is compiled by Vite's built-in esbuild (tsconfig "jsx": "react-jsx"); @vitejs/plugin-react pulls in
  // Babel, whose semver@6 fails the workspace trust policy. Dev edits do a full reload instead of Fast Refresh.
  plugins: [swAssetList(), ...(LIVE ? [liveOperations()] : [])],
  esbuild: { jsx: 'automatic' },
  define: { __GOVERN_DATA__: JSON.stringify(DATA) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // the built console is served by Next.js under its Content-Security-Policy (script-src 'nonce-…' 'strict-dynamic')
  ...(LIVE && command === 'build' ? { html: { cspNonce: CSP_NONCE_PLACEHOLDER } } : {}),
  server: {
    port: 5190,
    strictPort: false,
    // same origin in development too: the session cookie, CSRF token and Origin check work as in production.
    // Server-Sent Events (/api/console/stream) pass through unbuffered.
    ...(LIVE ? { proxy: { '/api': { target: API, changeOrigin: false, ws: false } } } : {}),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, re] of VENDOR_CHUNKS) if (re.test(id)) return name;
          if (/[\\/]src[\\/]mock[\\/]/.test(id)) return 'demo-data';
          return undefined;
        },
      },
    },
  },
}));
