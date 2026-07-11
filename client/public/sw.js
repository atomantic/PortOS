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

// Matches the `/assets/...` references (entry chunk + modulepreload deps + CSS)
// in the shell HTML. The set these produce is the boot JS/CSS the app can't
// start without.
const BOOT_ASSET_RE = /(?:src|href)="(\/assets\/[^"]+)"/g;

function parseBootAssetPaths(html) {
  return [...new Set([...html.matchAll(BOOT_ASSET_RE)].map((m) => m[1]))];
}

self.addEventListener('install', (event) => {
  // Adopt the new worker as soon as it's installed. Combined with network-first
  // navigations + the app's stale-chunk reload, this is safe: an open tab keeps
  // its in-memory JS, and its next navigation re-fetches the fresh shell.
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      // Pre-warm the shell under the stable SHELL_KEY (NOT the request URL) so
      // the very first offline navigation — including a deep-link reload —
      // works even if the user never made an online navigation through the SW.
      // navigationHandler reads the offline fallback from SHELL_KEY, so the
      // pre-warm must write the same key (cache.add would key it by "/" and the
      // fallback would miss). Best-effort — a failure must not abort install.
      const response = await fetch(new Request('/', { cache: 'reload' })).catch(() => null);
      if (!response || !response.ok) return;
      const shell = await caches.open(SHELL_CACHE);
      await shell.put(SHELL_KEY, response.clone());
      // Precache this build's boot assets (entry chunk + modulepreload deps +
      // CSS parsed from the shell) so a FIRST-VISIT offline reload can boot: on
      // a fresh install the SW only starts controlling the page after
      // window.load, so the initial page's /assets/* were network-served and
      // never entered ASSET_CACHE. trimCache derives the pinned set from the
      // committed shell, so no in-memory bookkeeping is needed here.
      await precacheBootAssets(await response.text());
    })()
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
  const shell = await caches.open(SHELL_CACHE);
  try {
    // Prefer the browser's navigation-preload response when available.
    const preload = await event.preloadResponse;
    const response = preload || (await fetch(event.request));
    if (response && response.ok) {
      // Update the offline shell + boot assets in the BACKGROUND so the
      // navigation response isn't delayed. Only REPLACE the known-good shell
      // once this build's boot assets are all cached — so a half-downloaded
      // deploy (new HTML fetched, its hashed assets not yet downloaded, e.g. a
      // flaky link mid-rollout) can't strand the offline fallback on a shell
      // whose assets are unavailable. trimCache re-derives the pinned set from
      // whichever shell is committed, so old assets stay pinned until the new
      // shell actually takes over.
      const toCache = response.clone();
      const background = (async () => {
        const { cachedAll } = await precacheBootAssets(await toCache.clone().text());
        if (cachedAll) await shell.put(SHELL_KEY, toCache);
      })().catch(() => {});
      // Keep the SW alive until the caching finishes. waitUntil is only valid
      // while the event is still extendable; guard it so that if the browser
      // rejects a late call it can't fall through to the catch below and return
      // a STALE shell — the fresh network response must always win online.
      try {
        event.waitUntil(background);
      } catch { /* event no longer extendable — caching runs best-effort */ }
    }
    return response;
  } catch {
    const cached = await shell.match(SHELL_KEY);
    if (cached) return cached;
    // Last resort: whatever we have for this exact navigation URL.
    const exact = await caches.match(event.request);
    if (exact) return exact;
    return Response.error();
  }
}

// Parse the shell HTML's `/assets/...` references (entry chunk + its
// modulepreload deps + CSS) and warm them into ASSET_CACHE. Returns the
// referenced `urls` plus `cachedAll` — true iff every referenced asset is now
// cached — which the caller uses to gate replacing a known-good offline shell.
async function precacheBootAssets(html) {
  const urls = parseBootAssetPaths(html);
  if (!urls.length) return { urls, cachedAll: true };
  const cache = await caches.open(ASSET_CACHE);
  const results = await Promise.all(urls.map(async (url) => {
    if (await cache.match(url)) return true;
    const r = await fetch(url).catch(() => null);
    if (r && r.ok) {
      await cache.put(url, r);
      return true;
    }
    return false;
  }));
  return { urls, cachedAll: results.every(Boolean) };
}

// The boot-asset paths referenced by the currently-cached offline shell, read
// back from Cache Storage (durable — unaffected by the SW global being torn
// down between events). Empty when no shell is cached yet.
async function cachedShellBootAssets() {
  const shell = await caches.open(SHELL_CACHE);
  const cached = await shell.match(SHELL_KEY);
  if (!cached) return new Set();
  return new Set(parseBootAssetPaths(await cached.text()));
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
//
// The current shell's boot assets are NEVER evicted, even though they're the
// oldest insertions: the shell can't start without them, so trimming them would
// break a later offline reload. The pinned set is derived FROM the cached shell
// on each trim (not an in-memory variable) so it survives the SW being
// discarded between events and can never disagree with the committed shell.
// Trim only the runtime chunks (lazy route splits, old builds' assets),
// oldest-first.
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const pinned = await cachedShellBootAssets();
  const trimmable = keys.filter((req) => !pinned.has(new URL(req.url).pathname));
  const excess = trimmable.slice(0, keys.length - maxEntries);
  await Promise.all(excess.map((key) => cache.delete(key)));
}
