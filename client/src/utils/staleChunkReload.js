import { safeReadSession, safeWriteSession } from '../lib/safeStorage.js';
import { sleep } from './sleep.js';

// Cross-browser detection for stale dynamic-import chunk errors that happen
// after a rebuild changes Vite chunk hashes while a tab is still open.
//
// Browser variants observed:
//   - Chrome:  "Failed to fetch dynamically imported module"
//   - Firefox: "error loading dynamically imported module"
//   - Safari:  "Importing a module script failed"
//   - Any browser when the new chunk's MIME type comes back wrong
const STALE_CHUNK_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'mime type'
];

// These can mean an old/new module graph supplied incompatible runtime exports,
// but the same messages can come from real application bugs. Match them only
// at import/render boundaries; recovery still requires a confirmed newer build.
const MODULE_EVALUATION_PATTERNS = ['superclass is not a constructor'];
const SAFARI_RUNTIME_EXPORTS = ['useState', 'jsx'];

const RELOAD_FLAG = 'portos.staleChunkReloadAttempted';
const reloadAttempts = new Map();

// The service worker names every cache it owns with this prefix
// (`portos-shell-v1`, `portos-assets-v1`, …). Mirrored from public/sw.js so the
// page can drop them without the SW's cooperation — Cache Storage is shared
// between the page and its controlling worker on the same origin.
const CACHE_PREFIX = 'portos-';

// Bound both the live-build probe and a confirmed-new-build cache purge.
const PURGE_TIMEOUT_MS = 1500;

export const isStaleChunkError = (err, { duringImport = false, duringRender = false } = {}) => {
  const msg = (err?.message || String(err || '')).toLowerCase();
  if (STALE_CHUNK_PATTERNS.some(p => msg.includes(p))) return true;
  if (!duringImport && !duringRender) return false;

  return MODULE_EVALUATION_PATTERNS.some((p) => msg.includes(p))
    || (msg.includes('undefined is not an object')
      && msg.includes('evaluating')
      && SAFARI_RUNTIME_EXPORTS.some((name) => msg.includes(`.${name.toLowerCase()}`)));
};

// Anti-loop guard: stash the build id we already attempted a reload for. A
// stale-chunk error in a *different* build (one we haven't yet tried to
// recover from) still triggers a reload. The old session-wide one-shot
// guard left the user stuck on the error screen after a second rebuild.
const getCurrentBuildId = () => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="portos-build-id"]');
  return el ? el.getAttribute('content') : null;
};

// Drop the service worker's offline caches (app shell + hashed asset chunks) so
// the recovery reload is GUARANTEED to boot the fresh bundle. Without this, the
// SW's cache-first `/assets/` strategy — and, on a flaky mobile link, its
// network-first navigation falling back to the cached shell — can re-serve the
// exact stale code that just 404'd. That would waste the one-shot reload guard
// and strand the user on the error screen ("still Importing a module script
// failed even after a reload"). Content-hashed assets that are still valid just
// get re-fetched once; the cost is a single cold load. Best-effort and guarded
// so a missing/disabled Cache Storage is a no-op, not a throw.
export const purgeOfflineCaches = async () => {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return;
  const keys = await caches.keys().catch(() => []);
  await Promise.all(
    keys
      .filter((name) => name.startsWith(CACHE_PREFIX))
      .map((name) => caches.delete(name).catch(() => {}))
  );
};

// Resolve when `promise` settles or after `ms`, whichever comes first — so a
// slow/hung purge can't block the recovery reload indefinitely.
const withTimeout = (promise, ms) =>
  Promise.race([
    Promise.resolve(promise).catch(() => {}),
    sleep(ms),
  ]);

// A flaky or dead network produces the same import-error messages as a
// genuinely stale chunk, but the purge only helps when the server actually has
// a NEW build to hand back. Purging on a transient failure would destroy the
// valid current-build offline shell — if the link then drops again during the
// recovery reload, the service worker has no fallback and the user lands on
// the browser's connection-error page instead of the offline app. So before
// purging, fetch the server's live shell and read the build id it stamps into
// index.html (`server/lib/buildId.js`): only a confirmed different build
// justifies dropping the caches. Returns the server's build id, or null when
// offline/unreachable/unstamped (all "do not purge" signals). `cache:
// 'no-store'` bypasses the HTTP cache, and the unique query param guarantees a
// Cache Storage miss inside the service worker — its fallback for this
// non-navigation GET is `caches.match(request)`, which `no-store` does NOT
// bypass, so without the param a historical cache entry keyed `/` could answer
// the probe with old HTML and fake a "different build" while offline.
export const fetchServerBuildId = async () => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const res = await fetch(`/?portos-build-probe=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const html = await res.text().catch(() => '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.querySelector('meta[name="portos-build-id"]');
  return (el && el.getAttribute('content')) || null;
};

export const reloadOnceForStaleChunk = ({ forceCachePurge = false } = {}) => {
  const buildId = getCurrentBuildId();
  if (!buildId) return Promise.resolve(false);
  if (reloadAttempts.has(buildId)) {
    const inFlight = reloadAttempts.get(buildId);
    if (!forceCachePurge) return inFlight;
    // The route fallback can be retried while its automatic, conservative
    // check is still probing. If that check finds the same build, continue the
    // user's explicit retry with a cache purge instead of falling back to a
    // plain reload.
    return inFlight.then((reloaded) => (
      reloaded ? true : reloadOnceForStaleChunk({ forceCachePurge: true })
    ));
  }
  if (safeReadSession(RELOAD_FLAG) === buildId) return Promise.resolve(false);

  const attempt = (async () => {
    // A rejected preload can be a transient network error, and a runtime export
    // error can be an application bug. Reload only when the live shell proves
    // this tab is running a different build; an offline/unknown/same-build
    // result leaves the current page and its unsaved state intact unless the
    // user explicitly requested a fresh-asset retry.
    const serverBuildId = await withTimeout(fetchServerBuildId(), PURGE_TIMEOUT_MS);
    if (!serverBuildId) return false;
    const newerBuildAvailable = serverBuildId !== buildId;
    const explicitRetryCanRecover = forceCachePurge
      && !newerBuildAvailable
      && !(typeof navigator !== 'undefined' && navigator.onLine === false);
    if (!newerBuildAvailable && !explicitRetryCanRecover) return false;

    // Persist the anti-loop guard after confirming either a newer build or an
    // explicit, online retry. An automatic same-build or offline probe remains
    // eligible for a later deployment.
    safeWriteSession(RELOAD_FLAG, buildId);
    if (safeReadSession(RELOAD_FLAG) !== buildId) {
      console.warn('🔄 A stale chunk was detected but sessionStorage is unavailable — skipping reload to avoid a reload loop');
      return false;
    }

    console.warn(newerBuildAvailable
      ? `🔄 Stale chunk detected (page build ${buildId}, server build ${serverBuildId}) — reloading`
      : `🔄 Clearing cached PortOS assets after explicit retry (build ${buildId}) — reloading`);
    // Purge the offline caches before reloading so a stale shell or asset does
    // not get served again. The normal automatic path gets here only after a
    // build mismatch; the explicit retry gets here only after the live shell
    // responds and the browser is not known to be offline.
    await withTimeout(purgeOfflineCaches(), PURGE_TIMEOUT_MS);
    window.location.reload();
    return true;
  })().catch(() => false).finally(() => {
    reloadAttempts.delete(buildId);
  });

  reloadAttempts.set(buildId, attempt);
  return attempt;
};
