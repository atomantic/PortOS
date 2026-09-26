/**
 * Atomic file write helper for the aiToolkit.
 *
 * Vendored copy of server/lib/fileUtils.js#atomicWrite so the toolkit stays
 * self-contained (no imports out to sibling PortOS modules — see AGENTS.md
 * "AI Toolkit" section). Keep in sync with the upstream implementation:
 *
 *   PARITY REQUIREMENT: every change to server/lib/fileUtils.js#atomicWrite
 *   must be mirrored here and vice-versa. The critical invariant is the
 *   payload-coercion line: Buffer must pass through unchanged (JSON.stringify
 *   on a Buffer produces `{"type":"Buffer","data":[...]}`, corrupting binary
 *   writes). String and Buffer both bypass stringify; everything else is
 *   serialised with 2-space indentation.
 *
 * Writes data to a temp file, then renames atomically so readers never see
 * a partial write. Accepts a string, a Buffer, or any JSON-serializable value.
 */

import { mkdir, writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

const WIN_RETRY_ATTEMPTS = 5;
const WIN_RETRY_DELAY_MS = 10;
const WIN_BACKUP_RETRY_ATTEMPTS = 20;
const WIN_BACKUP_RETRY_DELAY_MS = 25;
const WIN_RENAME_LOCK_CODES = ['EPERM', 'EACCES', 'EEXIST', 'EBUSY'];
const isWindows = () => process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithWindowsRetries(from, to, {
  attempts = WIN_RETRY_ATTEMPTS,
  delayMs = WIN_RETRY_DELAY_MS,
} = {}) {
  let err = await rename(from, to).then(() => null, (e) => e);
  if (isWindows()) {
    for (let attempt = 1; err && attempt < attempts && WIN_RENAME_LOCK_CODES.includes(err.code); attempt += 1) {
      await sleep(delayMs);
      err = await rename(from, to).then(() => null, (e) => e);
    }
  }
  return err;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function atomicWrite(filePath, data) {
  // Buffer must pass through unchanged — JSON.stringify on a Buffer produces
  // `{"type":"Buffer","data":[...]}` which corrupts binary writes (PNG, etc.).
  const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, payload);
  const replace = async () => {
    const err = await renameWithWindowsRetries(tmp, filePath);
    if (!err) return;
    if (isWindows() && WIN_RENAME_LOCK_CODES.includes(err.code)) {
      const bak = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
      const backupError = await renameWithWindowsRetries(filePath, bak, {
        attempts: WIN_BACKUP_RETRY_ATTEMPTS,
        delayMs: WIN_BACKUP_RETRY_DELAY_MS,
      });
      if (backupError && backupError.code !== 'ENOENT') throw backupError;
      const hadExisting = !backupError;
      const renameErr = await renameWithWindowsRetries(tmp, filePath);
      if (renameErr) {
        if (hadExisting) await renameWithWindowsRetries(bak, filePath);
        throw renameErr;
      }
      if (hadExisting) await unlink(bak).catch(() => {});
      return;
    }
    throw err;
  };
  try {
    await replace();
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
