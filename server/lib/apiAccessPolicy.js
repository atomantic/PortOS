/** Shared authentication-boundary metadata for HTTP API discovery and auth. */

export const ALWAYS_PUBLIC_API_PATHS = Object.freeze([
  '/api/auth/status',
  '/api/auth/whoami',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/system/health',
]);

export const GATED_NON_API_PREFIXES = Object.freeze(['/sdapi/']);

const alwaysPublicPathSet = new Set(ALWAYS_PUBLIC_API_PATHS);

export const isAlwaysPublicApiPath = (path) => alwaysPublicPathSet.has(path);
