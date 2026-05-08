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

// Reloads once per session — sessionStorage guard prevents infinite loops if
// the new bundle is also broken. Returns true if a reload was triggered.
export const reloadOnceForStaleChunk = () => {
  if (sessionStorage.getItem(RELOAD_FLAG)) return false;
  sessionStorage.setItem(RELOAD_FLAG, '1');
  console.warn('🔄 Stale chunk detected — reloading to pick up new bundle');
  window.location.reload();
  return true;
};
