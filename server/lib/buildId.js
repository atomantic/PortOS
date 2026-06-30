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
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', '..', 'client', 'dist', 'index.html');

// Cached snapshot of the stamped HTML + its build id, keyed on the index.html
// mtime. Vite rewrites index.html every build (new chunk filenames inside), so
// a pure module-level cache would keep serving the old stamped HTML — the
// browser would then request chunk filenames that no longer exist on disk →
// 404 → black page.
//
// The previous design `statSync`'d index.html on EVERY SPA navigation to detect
// a rebuild, blocking the event loop for that I/O on each request. We now
// THROTTLE the freshness check: at most one `stat` per CHECK_THROTTLE_MS
// regardless of request rate. Between checks the hot path is just a clock
// comparison (no syscall). On a check the (cheap, OS-inode-cached) `stat`
// compares mtime and recomputes only on an actual change, so the served HTML
// re-syncs with the on-disk chunks within the throttle window — bounded, and it
// always self-heals (no reliance on filesystem change events, which drop on
// some platforms). In production the server is restarted as part of an update
// (the client is rebuilt while the process is down), so the boot-time prime
// already reads the fresh bundle; the throttled check only matters for a manual
// rebuild against a long-running dev server.
let cached = null;
let lastCheckAt = 0;

const CHECK_THROTTLE_MS = 1000;

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

// Synchronous (re)compute — reads index.html once. Runs at boot and again only
// when a throttled check detects a changed mtime, NOT on every request.
function computeSync() {
  if (!existsSync(INDEX_PATH)) return DEV_SNAPSHOT;
  const mtimeMs = statSync(INDEX_PATH).mtimeMs;
  return deriveFromHtml(readFileSync(INDEX_PATH, 'utf8'), mtimeMs);
}

// Throttled freshness check. Cheap (`stat` hits the OS inode cache) and capped
// at one per CHECK_THROTTLE_MS, so request bursts collapse to a single check.
function checkForRebuild() {
  if (!existsSync(INDEX_PATH)) {
    if (cached.id !== 'dev') cached = DEV_SNAPSHOT;
    return;
  }
  if (statSync(INDEX_PATH).mtimeMs !== cached.mtimeMs) cached = computeSync();
}

function ensureFresh() {
  if (!cached) {
    cached = computeSync();
    lastCheckAt = Date.now();
    return cached;
  }
  const now = Date.now();
  if (now - lastCheckAt >= CHECK_THROTTLE_MS) {
    lastCheckAt = now;
    checkForRebuild();
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
 * Force a synchronous recompute (bypassing the throttle) and return the
 * resulting snapshot. The hot-path getters recompute at most once per throttle
 * window; this is the explicit hook for callers that need the freshest value
 * right now (boot warm-up, tests).
 *
 * @returns {{id: string, html: string|null, mtimeMs: number}}
 */
export function refreshBuildId() {
  cached = computeSync();
  lastCheckAt = Date.now();
  return cached;
}
