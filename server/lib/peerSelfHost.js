// Returns the Tailscale-issued hostname this PortOS sends in federation
// announces. Self-signed mode binds to localhost + IPs, which can't be
// announced as a host, so falls through to null.
import { PATHS } from './fileUtils.js';
import { certPaths } from '../../lib/certPaths.js';
import { readCertMeta } from '../../lib/certMeta.js';

// `PATHS.data` is resolved at call time (not module load) so test harnesses
// that proxy `fileUtils.PATHS` after import — and every transitive importer
// of this module via `instances.js` — see their override.
export function getSelfHost() {
  if (process.env.PORTOS_HOST) return process.env.PORTOS_HOST;

  const { meta: META_PATH } = certPaths(PATHS.data);
  const meta = readCertMeta(META_PATH);
  if (!meta) return null;
  return meta.mode === 'tailscale' && typeof meta.hostname === 'string' && meta.hostname
    ? meta.hostname
    : null;
}
