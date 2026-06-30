/**
 * Build-ID derived from the built client bundle.
 *
 * Computed once at server boot from `client/dist/index.html` (the file
 * changes every Vite build because it embeds the bundle-hash filenames).
 * Used in two places:
 *
 *   - `server/index.js` — injects `<meta name="portos-build-id" content="...">`
 *     into the served index.html so the bundled JS can read its own build id.
 *   - `server/services/socket.js` — emits the current build id to every
 *     connecting socket. A client whose embedded id differs from the live
 *     server's id knows it's running stale code and can prompt to reload.
 *
 * During `npm run dev` (Vite dev server, no `client/dist`) the id falls
 * back to `'dev'` and the socket emission is a no-op match.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', '..', 'client', 'dist', 'index.html');

// Cache keyed on the index.html mtime — Vite rewrites this file every build,
// so a changed mtime means new chunk filenames inside. A pure module-level
// cache would keep serving the old stamped HTML (and reporting the old build
// id over the socket) after `npm run build`, so the browser would request
// chunk filenames that no longer exist on disk → 404 → black page.
//
// The cache is refreshed OFF the request hot path: the synchronous getters
// return the cached snapshot immediately and kick a non-blocking `fs.stat` +
// `fs.readFile` refresh. The previous implementation `statSync`'d on every SPA
// navigation, blocking the event loop for that I/O on each request. The first
// call primes the cache synchronously (server boot) so the very first response
// is correct; thereafter a rebuild is picked up on the next request after the
// async refresh settles (sub-millisecond on a local disk). Refreshes are
// deduped (one in flight) and throttled so a request burst can't fan out a
// `stat` per request.
let cached = null;
let refreshing = null; // in-flight refresh promise, or null
let lastRefreshAt = 0; // throttle clock (ms)

const REFRESH_THROTTLE_MS = 1000;

const DEV_SNAPSHOT = { id: 'dev', html: null, mtimeMs: 0 };

// Pure: hash + stamp the meta tag into the html. Shared by the sync prime and
// the async refresh so the two paths can't drift.
function deriveFromHtml(html, mtimeMs) {
  const id = createHash('sha256').update(html).digest('hex').slice(0, 12);
  // Inject the meta tag once. Idempotent: replace if already present
  // (defensive — Vite rewrites the whole file so the marker shouldn't survive
  // a rebuild, but checking keeps the function safe to call repeatedly).
  const META = `<meta name="portos-build-id" content="${id}">`;
  const META_RE = /<meta name="portos-build-id" content="[^"]*">/;
  const stamped = META_RE.test(html)
    ? html.replace(META_RE, META)
    : html.replace('</head>', `  ${META}\n  </head>`);
  return { id, html: stamped, mtimeMs };
}

// Synchronous prime — used once on the first getter call (server boot) so the
// cache is never empty when a value is read. One sync stat+read here is fine; it
// happens at most once, not per request.
function primeSync() {
  if (!existsSync(INDEX_PATH)) {
    cached = DEV_SNAPSHOT;
    return cached;
  }
  const mtimeMs = statSync(INDEX_PATH).mtimeMs;
  cached = deriveFromHtml(readFileSync(INDEX_PATH, 'utf8'), mtimeMs);
  return cached;
}

// Async refresh — recompute only when the mtime moved. Runs off the request
// path so its I/O never blocks the event loop for the current response.
async function refresh() {
  const s = await stat(INDEX_PATH).catch(() => null);
  if (!s) {
    if (!cached || cached.id !== 'dev') cached = DEV_SNAPSHOT;
    return cached;
  }
  if (!cached || cached.mtimeMs !== s.mtimeMs) {
    const html = await readFile(INDEX_PATH, 'utf8').catch(() => null);
    if (html != null) cached = deriveFromHtml(html, s.mtimeMs);
  }
  return cached;
}

// Kick a deduped, throttled background refresh. Non-blocking — the caller reads
// the (possibly one-request-stale) cache while this settles.
function scheduleRefresh() {
  if (refreshing) return;
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  lastRefreshAt = now;
  refreshing = refresh().finally(() => { refreshing = null; });
}

function ensureFresh() {
  if (!cached) return primeSync();
  scheduleRefresh();
  return cached;
}

export function getBuildId() {
  return ensureFresh().id;
}

export function getStampedIndexHtml() {
  return ensureFresh().html;
}

/**
 * Force a refresh and resolve the resulting snapshot. Bypasses the throttle so
 * callers that need the freshest value right now (boot warm-up, tests) can
 * `await` it. The hot-path getters never call this — they stay non-blocking via
 * `scheduleRefresh`.
 *
 * @returns {Promise<{id: string, html: string|null, mtimeMs: number}>}
 */
export async function refreshBuildId() {
  if (!cached) primeSync();
  lastRefreshAt = Date.now();
  refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}
