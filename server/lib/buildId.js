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

import { existsSync, readFileSync, statSync, watch } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', '..', 'client', 'dist', 'index.html');
const DIST_DIR = dirname(INDEX_PATH);

// Cached snapshot of the stamped HTML + its build id, plus an event-driven
// staleness flag. Vite rewrites index.html every build (new chunk filenames
// inside), so a pure module-level cache would keep serving the old stamped HTML
// — the browser would then request chunk filenames that no longer exist on disk
// → 404 → black page.
//
// The previous design `statSync`'d index.html on EVERY SPA navigation to detect
// a rebuild. That blocked the event loop for that I/O on each request. Instead
// we watch the dist directory: any write to index.html flags the cache stale,
// and the next getter recomputes synchronously exactly once. So a request never
// pays a stat, yet a rebuild-while-running is reflected immediately on the very
// next read — the served HTML always matches the on-disk chunks (no stale-chunk
// window). In production the server is restarted as part of an update (the
// client is rebuilt while the process is down), so the boot-time prime already
// reads the fresh bundle; the watcher only matters for a manual rebuild against
// a long-running dev server.
let cached = null;
let dirty = false;
let watcher = null;
let lastStatAt = 0;

// When the watcher CAN'T be armed (fs.watch unsupported, or it errored out), a
// rebuild would otherwise go undetected until restart. In that degraded mode we
// fall back to a stat — throttled so it stays cheap — so the cache self-heals.
// No stat is taken while the watcher is healthy.
const STAT_FALLBACK_MS = 1000;

const DEV_SNAPSHOT = { id: 'dev', html: null, mtimeMs: 0 };

// Pure: hash + stamp the meta tag into the html.
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

// Synchronous (re)compute — reads index.html once. Runs at boot (the first
// getter call) and again only after the watcher flags a rebuild, NOT per
// request. The mtime is captured purely for cache-equality diagnostics.
function computeSync() {
  if (!existsSync(INDEX_PATH)) return DEV_SNAPSHOT;
  const mtimeMs = statSync(INDEX_PATH).mtimeMs;
  return deriveFromHtml(readFileSync(INDEX_PATH, 'utf8'), mtimeMs);
}

// Watch the dist DIRECTORY (Vite rewrites index.html via atomic rename, which a
// file-level watch loses after the first swap). Any event touching index.html
// marks the cache stale. Lazily armed on first read so it costs nothing in
// `npm run dev` (no dist dir) and re-arms if the directory appears later.
function ensureWatcher() {
  if (watcher || !existsSync(DIST_DIR)) return;
  // fs.watch can throw on platforms/filesystems without change notification;
  // a failure just means we fall back to the boot-time prime (correct for the
  // production restart-on-update flow), so swallow and leave watcher null.
  try {
    watcher = watch(DIST_DIR, (_event, filename) => {
      // filename is null on some platforms — treat any event as a possible
      // index.html change rather than miss a rebuild.
      if (!filename || filename === 'index.html') dirty = true;
    });
    watcher.unref(); // never keep the event loop alive
    watcher.on('error', () => { closeWatcher(); }); // re-arm on next read
    // The watcher only catches FUTURE writes; if the dist dir just appeared
    // (a build completed against a running dev server), recompute once so an
    // index.html that landed before the watcher armed isn't missed.
    dirty = true;
  } catch {
    watcher = null;
  }
}

// Degraded-mode fallback: only runs when the watcher is NOT armed. A throttled
// stat detects a rebuild so the cache can't go permanently stale on a platform
// without working fs.watch. Cheap (OS inode cache) and bounded to one per
// STAT_FALLBACK_MS regardless of request rate.
function maybeStatRefresh() {
  const now = Date.now();
  if (now - lastStatAt < STAT_FALLBACK_MS) return;
  lastStatAt = now;
  if (!existsSync(INDEX_PATH)) {
    if (cached.id !== 'dev') cached = DEV_SNAPSHOT;
    return;
  }
  if (statSync(INDEX_PATH).mtimeMs !== cached.mtimeMs) cached = computeSync();
}

function closeWatcher() {
  if (!watcher) return;
  try { watcher.close(); } catch { /* already closed */ }
  watcher = null;
}

function ensureFresh() {
  ensureWatcher();
  if (!cached || dirty) {
    cached = computeSync();
    dirty = false;
  } else if (!watcher) {
    // Watcher couldn't be armed/maintained — fall back to a throttled stat so a
    // rebuild is still picked up instead of serving stale chunks until restart.
    maybeStatRefresh();
  }
  return cached;
}

export function getBuildId() {
  return ensureFresh().id;
}

export function getStampedIndexHtml() {
  return ensureFresh().html;
}

/**
 * Force a synchronous recompute and return the resulting snapshot. The hot-path
 * getters recompute only when the watcher flags a rebuild; this is the explicit
 * hook for callers that want to recompute right now (boot warm-up, tests).
 *
 * @returns {{id: string, html: string|null, mtimeMs: number}}
 */
export function refreshBuildId() {
  cached = computeSync();
  dirty = false;
  return cached;
}

/** Test-only: tear down the dist watcher so a `vi.resetModules()` suite doesn't
 *  leak watch handles across re-imports. */
export function __closeWatcherForTests() {
  closeWatcher();
}
