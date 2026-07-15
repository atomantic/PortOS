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

const RELOAD_FLAG = 'portos.staleChunkReloadAttempted';

// The service worker names every cache it owns with this prefix
// (`portos-shell-v1`, `portos-assets-v1`, …). Mirrored from public/sw.js so the
// page can drop them without the SW's cooperation — Cache Storage is shared
// between the page and its controlling worker on the same origin.
const CACHE_PREFIX = 'portos-';

// Upper bound on how long we wait for the cache purge before reloading anyway.
// A hung or absent Cache Storage (private mode, storage disabled/partitioned)
// must never leave the user stuck on the error screen — reload regardless.
const PURGE_TIMEOUT_MS = 1500;

export const isStaleChunkError = (err) => {
  const msg = (err?.message || String(err || '')).toLowerCase();
  return STALE_CHUNK_PATTERNS.some(p => msg.includes(p));
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
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);

// A dead network produces the same import-error messages as a genuinely stale
// chunk, but the purge only helps when the server can hand back fresh code.
// If the device is offline, purging would destroy the (possibly current-build)
// offline shell and strand the user on the browser's connection-error page —
// so probe first and keep the caches when unreachable; the recovery reload then
// falls back to the service worker's cached shell, which is the correct offline
// behavior. HEAD is never intercepted by the service worker (it handles GET
// only), so this probe cannot be satisfied from cache.
export const isServerReachable = async () => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const res = await fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  return Boolean(res && res.ok);
};

export const reloadOnceForStaleChunk = () => {
  const buildId = getCurrentBuildId();
  const flag = buildId ? `${buildId}` : '1';
  if (sessionStorage.getItem(RELOAD_FLAG) === flag) return false;
  sessionStorage.setItem(RELOAD_FLAG, flag);
  console.warn(`🔄 Stale chunk detected (build ${buildId || 'unknown'}) — clearing offline cache + reloading to pick up new bundle`);
  // Purge the offline caches BEFORE reloading so the reload can't be handed the
  // stale shell/chunks back — but only when the server is reachable (see
  // isServerReachable). Bounded by PURGE_TIMEOUT_MS so a hung probe or Cache
  // Storage still reloads. `reload()` fires exactly once — `Promise.race`
  // settles once.
  withTimeout(
    isServerReachable().then((reachable) => (reachable ? purgeOfflineCaches() : undefined)),
    PURGE_TIMEOUT_MS
  ).finally(() => {
    window.location.reload();
  });
  return true;
};
