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

export const reloadOnceForStaleChunk = () => {
  const buildId = getCurrentBuildId();
  const flag = buildId ? `${buildId}` : '1';
  if (sessionStorage.getItem(RELOAD_FLAG) === flag) return false;
  sessionStorage.setItem(RELOAD_FLAG, flag);
  console.warn(`🔄 Stale chunk detected (build ${buildId || 'unknown'}) — reloading to pick up new bundle`);
  window.location.reload();
  return true;
};
