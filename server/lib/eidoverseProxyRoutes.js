/**
 * Root paths the Eidoverse Worlds sequencer owns (from its server/routes.ts
 * matchers: exact + prefix). Import-free leaf so Vite, drift guards, and the
 * reverse-proxy can share one list without dragging Express into the graph.
 *
 * Keep in sync when the managed checkout adds root routes. Do not edit
 * checkouts under data/repos/ for PortOS-side proxy work — update THIS list.
 *
 * Mounted on PortOS :5555 only while the Eidoverse host is active, so these
 * names never permanently steal PortOS SPA / API behaviour.
 */
export const EIDOVERSE_HOST_PATH_PREFIX = '/eidoverse-host';

/** Exact pathnames (querystring ignored). `/host` is PortOS-terminated. */
export const EIDOVERSE_ROOT_EXACT_PATHS = Object.freeze([
  '/ws',
  '/authcfg',
  '/whoami',
  '/auth',
  '/logout',
  '/geom',
  '/residency',
  '/upload',
  '/seat-profile',
  '/snap',
  '/avatars',
  '/tick',
  '/defs',
  '/animations',
  '/relay-diag',
  '/version',
  '/embed-config',
  '/perflog',
  '/thumb',
  '/library-list',
  '/library-models',
  '/health',
  '/client-version',
  '/favicon.ico',
  '/host',
]);

/** Prefix matchers (path must start with the entry). */
export const EIDOVERSE_ROOT_PREFIX_PATHS = Object.freeze([
  '/thumb/',
  '/library/',
  '/node_modules/',
  '/shared/',
]);

const EXACT = new Set(EIDOVERSE_ROOT_EXACT_PATHS);

/**
 * @param {string} pathname pathname without query (trailing slashes already normalized or not)
 * @returns {boolean}
 */
export function isEidoverseRootProxyPath(pathname) {
  const path = String(pathname || '').split('?')[0] || '/';
  if (EXACT.has(path)) return true;
  // Upstream matches /agents.md case-insensitively.
  if (path.toLowerCase() === '/agents.md') return true;
  return EIDOVERSE_ROOT_PREFIX_PATHS.some((prefix) => path.startsWith(prefix));
}

/**
 * Strip `/eidoverse-host` from a request URL, leaving a leading `/` + query.
 * Returns null when the URL is not under the prefix.
 */
export function stripEidoverseHostPrefix(url) {
  const raw = String(url || '');
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q) : '';
  if (path === EIDOVERSE_HOST_PATH_PREFIX || path === `${EIDOVERSE_HOST_PATH_PREFIX}/`) {
    return `/${query}`;
  }
  if (path.startsWith(`${EIDOVERSE_HOST_PATH_PREFIX}/`)) {
    return `${path.slice(EIDOVERSE_HOST_PATH_PREFIX.length)}${query}`;
  }
  return null;
}
