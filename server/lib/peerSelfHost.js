// Returns the Tailscale-issued hostname this PortOS sends in federation
// announces. Self-signed mode binds to localhost + IPs, which can't be
// announced as a host, so falls through to null.
import { PATHS } from './fileUtils.js';
import { certPaths } from '../../lib/certPaths.js';
import { readCertMeta } from '../../lib/certMeta.js';

const { meta: META_PATH } = certPaths(PATHS.data);

export function getSelfHost() {
  if (process.env.PORTOS_HOST) return process.env.PORTOS_HOST;

  const meta = readCertMeta(META_PATH);
  if (!meta) return null;
  return meta.mode === 'tailscale' && typeof meta.hostname === 'string' && meta.hostname
    ? meta.hostname
    : null;
}
