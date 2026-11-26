/**
 * Owner-only storage for OAuth secrets and tokens: directory 0700, files 0600.
 *
 * mkdir's mode is umask-masked and ignored for existing dirs, so chmod enforces
 * it on existing directories. Secure files use an explicit mode before
 * the temporary inode is written or renamed into place.
 */
import { mkdir, chmod } from 'fs/promises';
import { atomicWrite } from './fileCore.js';

async function tighten(path, mode) {
  await chmod(path, mode).catch((err) => {
    if (err?.code !== 'ENOENT') console.log(`⚠️ Could not set permissions on OAuth store (${err?.code || 'error'})`);
  });
}

export async function ensureSecureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tighten(dir, 0o700);
}

export async function writeSecureJson(file, data) {
  await atomicWrite(file, data, { mode: 0o600 });
}
