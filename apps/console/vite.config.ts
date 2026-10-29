import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';

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

export default defineConfig({
  // JSX is compiled by Vite's built-in esbuild (tsconfig "jsx": "react-jsx"); @vitejs/plugin-react pulls in
  // Babel, whose semver@6 fails the workspace trust policy. Dev edits do a full reload instead of Fast Refresh.
  plugins: [swAssetList()],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5190, strictPort: false },
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
});
