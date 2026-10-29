/*
 * Elan1 Govern service worker. It makes the console installable on a phone and lets it open with no network.
 *
 *  - The shell: the start page, the manifest and the icons, cached on install.
 *  - The built scripts and stylesheets: the build writes /sw-assets.json, the list of every file under /assets/
 *    (the entry, the shared chunks and every lazily loaded screen). All of them are cached on install, so with no
 *    network the cached start page boots, sees the browser is offline and shows the /offline screen, which explains
 *    what still works. File names carry a content hash, so a cached file is never stale: they are served from the
 *    cache first, and anything not cached yet is cached the first time it loads.
 *  - Page navigations go to the network first and fall back to the cached start page. Each time a new start page
 *    arrives, the asset list is checked again: new files are cached and files from older builds are removed.
 *
 * Nothing else is cached: no API response, record, approval or receipt, and no personal data.
 */
const SHELL_CACHE = 'eg-shell-v2';
const ASSET_CACHE = 'eg-assets-v2';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const KEEP = [SHELL_CACHE, ASSET_CACHE];

let lastRefresh = 0;

/** Cache every built file named in /sw-assets.json; drop cached files that are no longer in it. */
async function precacheAssets() {
  let list;
  try {
    const res = await fetch('/sw-assets.json', { cache: 'no-store' });
    if (!res.ok) return;
    list = await res.json();
  } catch {
    return; // development server, or offline: the runtime cache below still fills as files load
  }
  if (!list || !Array.isArray(list.files)) return;
  const cache = await caches.open(ASSET_CACHE);
  const have = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
  const want = new Set(list.files);
  const missing = list.files.filter((f) => !have.has(f));
  for (let i = 0; i < missing.length; i += 12) {
    await Promise.all(missing.slice(i, i + 12).map((f) => cache.add(f).catch(() => undefined)));
  }
  await Promise.all([...have].filter((p) => !want.has(p)).map((p) => cache.delete(p)));
  lastRefresh = Date.now();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => precacheAssets())
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Page navigations: network first. Every route serves the same start page, so a fresh copy replaces the cached one.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const html = (res.headers.get('Content-Type') || '').includes('text/html');
          if (res.ok && html) {
            const copy = res.clone();
            event.waitUntil(
              caches.open(SHELL_CACHE).then((c) => c.put('/', copy))
                .then(() => (Date.now() - lastRefresh > 10 * 60_000 ? precacheAssets() : undefined)),
            );
          }
          return res;
        })
        .catch(() => caches.match('/', { cacheName: SHELL_CACHE }).then((r) => r || new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><p style="font:16px system-ui;padding:24px">Elan1 Govern needs a connection the first time it opens. Connect, open it once, and it will open offline after that.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))),
    );
    return;
  }

  // The asset list itself is always fetched fresh.
  if (url.pathname === '/sw-assets.json') return;

  // Built files: content-hashed, so the cached copy is served first; a file not cached yet is cached as it loads.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req, { cacheName: ASSET_CACHE }).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(ASSET_CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(req, { cacheName: SHELL_CACHE }).then((r) => r || fetch(req)));
  }
});
