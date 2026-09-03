/**
 * Harnesses — the coding-agent CLIs/TUIs PortOS drives (Models → Harnesses).
 *
 * Read-side only. The install / update / remove stream is SSE and goes through
 * the shared `RuntimeInstallModal`, which owns its own fetch-stream reader —
 * pointing it at `/api/harnesses/action` with `runtime` and `action` in the
 * query string, the same shape every BYO-runtime installer already uses.
 */

import { request } from './apiCore.js';

/**
 * Every harness with its installed version, the latest published version, and
 * the provider records riding on it.
 *
 * `fresh` bypasses both the runtime-status TTL and the npm-registry cache —
 * what the page's Refresh button sends, and what it re-reads after an action so
 * a just-installed version shows without waiting a cache out.
 */
export const getHarnesses = ({ fresh = false, ...options } = {}) =>
  request(`/harnesses${fresh ? '?fresh=1' : ''}`, options);

/**
 * Re-read one harness's own model catalog and write it to every provider that
 * draws from it. Resolves `{ models, updated }`; rejects with the server's
 * reason when the harness cannot list models or is signed out.
 */
export const refreshHarnessModels = (id, options) => request(
  `/harnesses/models/refresh?runtime=${encodeURIComponent(id)}`,
  { method: 'POST', ...options },
);
