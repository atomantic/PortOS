/**
 * certPaths — resolve the canonical cert / key / meta file paths under a
 * given data directory.
 *
 * Sibling of `lib/tailscale-https.js`, which consumes the `dir` this returns
 * as its `certDir` arg — keep them aligned so the `data/certs/{cert,key,meta}`
 * layout has exactly one definition. Zero-dep and side-effect-free, safe to
 * import from `scripts/`, `server/`, `server/lib/`, and managed-app code.
 *
 * Usage:
 *   import { certPaths } from '../lib/certPaths.js';
 *   const { dir, cert, key, meta } = certPaths(PATHS.data);
 *
 * @param {string} dataDir absolute path to the `data/` root (e.g. `PATHS.data`
 *   on the server, or `join(ROOT, 'data')` in scripts).
 * @returns {{ dir: string, cert: string, key: string, meta: string }}
 */
import { join } from 'path';

export function certPaths(dataDir) {
  const dir = join(dataDir, 'certs');
  return {
    dir,
    cert: join(dir, 'cert.pem'),
    key: join(dir, 'key.pem'),
    meta: join(dir, 'meta.json'),
  };
}
