// Returns the Tailscale-issued hostname this PortOS sends in federation
// announces. Self-signed mode binds to localhost + IPs, which can't be
// announced as a host, so falls through to null.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './fileUtils.js';

const META_PATH = join(PATHS.data, 'certs', 'meta.json');

export function getSelfHost() {
  if (process.env.PORTOS_HOST) return process.env.PORTOS_HOST;

  const stat = statSync(META_PATH, { throwIfNoEntry: false });
  if (!stat) return null;

  const meta = JSON.parse(readFileSync(META_PATH, 'utf-8'));
  return meta.mode === 'tailscale' && typeof meta.hostname === 'string' && meta.hostname
    ? meta.hostname
    : null;
}
