/**
 * certMeta — best-effort reader for the `data/certs/meta.json` marker that
 * `npm run setup:cert` writes. Returns null on missing-or-partial so callers
 * treat "no meta" the same as "no cert" without each one re-implementing the
 * guard.
 *
 * Sibling of `lib/certPaths.js` and `lib/tailscale-https.js`. Zero-dep and
 * side-effect-free, safe to import from `scripts/`, `server/`, `server/lib/`,
 * and managed-app code — which is why this inlines `JSON.parse` + try/catch
 * rather than reusing `server/lib/fileUtils.js#safeJSONParse` (that would
 * pull the server-lib chain into `scripts/` and managed apps).
 *
 * Usage:
 *   import { certPaths } from './lib/certPaths.js';
 *   import { readCertMeta } from './lib/certMeta.js';
 *   const { meta: META_PATH } = certPaths(PATHS.data);
 *   const meta = readCertMeta(META_PATH);  // null when absent or mid-write
 *
 * @param {string} metaPath absolute path to `meta.json`.
 * @returns {object | null}
 */
import { readFileSync, statSync } from 'node:fs';

export function readCertMeta(metaPath) {
  try {
    const stat = statSync(metaPath, { throwIfNoEntry: false });
    if (!stat) return null;
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // EACCES on stat / read, EIO, malformed JSON, primitive JSON — every
    // failure mode collapses to "no meta", matching the legacy inline
    // try/catch print-access-url.js used to carry.
    return null;
  }
}
