/* PortOS service worker — offline app-shell + low-bandwidth asset caching.
 *
 * This is the modern replacement for the long-deprecated AppCache manifest.
 * It caches the built app shell (index.html) and the content-hashed JS/CSS
 * chunks so PortOS loads instantly on repeat visits, keeps working when the
 * server is briefly unreachable (flaky Tailnet links), and stops re-pulling
 * megabytes of vendor JS on every navigation over a slow connection.
 *
 * Design constraints specific to PortOS:
 *   - `/api/*`, `/socket.io/*` and `/data/*` are NEVER cached. They are
 *     real-time / large / user-specific — the app is inherently online for
 *     data, only the *shell* is made offline-capable here.
 *   - Vite emits content-hashed filenames under `/assets/`, so those are
 *     immutable and safe to serve cache-first. A new build produces new
 *     filenames (cache miss → fetched fresh), so cache-first never pins stale
 *     code. The existing build-id / stale-chunk-reload machinery
 *     (server/lib/buildId.js, client/src/utils/staleChunkReload.js) still
 *     handles the "server rebuilt while a tab was open" case.
 *   - Navigations are network-first so a fresh build is always picked up when
 *     online; the cached shell is the offline fallback only.
 *
 * Bump CACHE_VERSION to invalidate every cache (e.g. when these strategies
 * change). Changing this file's bytes is itself what triggers the browser to
 * install the updated worker.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `portos-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `portos-assets-${CACHE_VERSION}`;
const STATIC_CACHE = `portos-static-${CACHE_VERSION}`;
const FONT_CACHE = `portos-fonts-${CACHE_VERSION}`;

const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, STATIC_CACHE, FONT_CACHE]);

// Stable key the offline shell is stored under, independent of the request URL
// (every SPA navigation resolves to the same index.html on the server).
const SHELL_KEY = '/index.html';

// Cap the immutable-asset cache so many rebuilds don't grow it without bound.
// Old build chunks accumulate here (their hashed names never collide); trim to
// the most-recently-added entries. Generous because a single build's chunk set
// is well under this.
const ASSET_CACHE_MAX_ENTRIES = 120;

// Same-origin static assets that are safe to serve stale-while-revalidate:
// fonts, icons, the PWA manifest, sky textures, the logo. Matched by path.
const STATIC_PATH_RE = /^\/(fonts|sky)\//;
const STATIC_FILE_RE = /^\/(manifest\.json|favicon\.(?:ico|svg)|apple-touch-icon\.png|icon-\d+\.png|portos-logo\.png)$/;

// External font hosts — cache-first is a big low-bandwidth win (Google serves
// these with long max-age already, but the browser HTTP cache is evicted more
// aggressively than a named SW cache).
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  // Adopt the new worker as soon as it's installed. Combined with network-first
  // navigations + the app's stale-chunk reload, this is safe: an open tab keeps
  // its in-memory JS, and its next navigation re-fetches the fresh shell.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Pre-warm the shell so the very first offline navigation works even if
      // the user never revisited "/" online. Best-effort — a failure here must
      // not abort activation.
      cache.add(new Request('/', { cache: 'reload' })).catch(() => {})
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Enabling navigation preload (speeds up network-first navigations) and
      // pruning caches from older worker versions are independent — run them
      // concurrently so activation isn't lengthened on a slow link.
      const enablePreload = self.registration.navigationPreload
        ? self.registration.navigationPreload.enable().catch(() => {})
        : Promise.resolve();
      const cleanup = caches.keys().then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('portos-') && !CURRENT_CACHES.has(name))
            .map((name) => caches.delete(name))
        )
      );
      await Promise.all([enablePreload, cleanup]);
      await self.clients.claim();
    })()
  );
});

// Allow the page to trigger an immediate takeover (e.g. an "update ready"
// prompt) without a full reload race.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable; everything else (POST/PUT/socket upgrades) passes
  // straight through to the network.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // Malformed URL — let the browser handle it.
  }

  const isSameOrigin = url.origin === self.location.origin;

  // External font stylesheets + font files: cache-first.
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // Never touch other cross-origin requests.
  if (!isSameOrigin) return;

  // Never cache dynamic / real-time / large-media routes. Let them hit the
  // network directly (also preserves HTTP Range for /data media).
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/data/')
  ) {
    return;
  }

  // SPA navigations: network-first, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(event));
    return;
  }

  // Content-hashed, immutable build output: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, ASSET_CACHE_MAX_ENTRIES));
    return;
  }

  // Static public assets (icons, fonts, manifest, textures): stale-while-revalidate.
  if (STATIC_PATH_RE.test(url.pathname) || STATIC_FILE_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // Anything else same-origin: try network, fall back to any cached copy.
  event.respondWith(networkFallingBackToCache(request));
});

// --- strategies ---------------------------------------------------------

async function navigationHandler(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // Prefer the browser's navigation-preload response when available.
    const preload = await event.preloadResponse;
    const response = preload || (await fetch(event.request));
    if (response && response.ok) {
      cache.put(SHELL_KEY, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    // Last resort: whatever we have for this exact navigation URL.
    const exact = await caches.match(event.request);
    if (exact) return exact;
    return Response.error();
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Cache successful basic/opaque responses. Opaque (cross-origin fonts) can't
  // be inspected but are safe to store and replay.
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
    if (maxEntries) trimCache(cache, maxEntries);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function networkFallingBackToCache(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return Response.error();
  }
}

// Trim a cache to its N most-recently-added entries (cache.keys() preserves
// insertion order, so the oldest are at the front). Takes an already-open
// cache handle. Fire-and-forget; only enumerates on the rare over-cap put.
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.slice(0, keys.length - maxEntries);
  await Promise.all(excess.map((key) => cache.delete(key)));
}
