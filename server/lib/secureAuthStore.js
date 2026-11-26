/**
 * Owner-only storage for secrets and credentials: directory 0700, files 0600.
 *
 * mkdir's mode is umask-masked and ignored for existing dirs, so chmod enforces
 * it on existing directories. Secure files use an explicit mode before
 * the temporary inode is written or renamed into place.
 */
import { mkdir, chmod, lstat } from 'fs/promises';
import { atomicWrite } from './fileCore.js';
import { isVitestRunner } from './runtimeEnv.js';

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

/** Repair a legacy file's permissions without reading or rewriting its contents. */
export async function tightenSecureFile(file) {
  if (process.platform === 'win32') return;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || (metadata.mode & 0o7777) === 0o600) return;
    if (isVitestRunner()) (await import('./testDataIsolation.js')).assertNotRealDataWrite(file, 'chmod');
    await chmod(file, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
