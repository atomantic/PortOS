/**
 * Atomic file write helper for the aiToolkit.
 *
 * Vendored copy of server/lib/fileCore.js#atomicWrite so the toolkit stays
 * self-contained (no imports out to sibling PortOS modules — see AGENTS.md
 * "AI Toolkit" section). Keep in sync with the upstream implementation:
 *
 *   PARITY REQUIREMENT: every change to server/lib/fileCore.js#atomicWrite
 *   must be mirrored here and vice-versa. The critical invariant is the
 *   payload-coercion line: Buffer must pass through unchanged (JSON.stringify
 *   on a Buffer produces `{"type":"Buffer","data":[...]}`, corrupting binary
 *   writes). String and Buffer both bypass stringify; everything else is
 *   serialised with 2-space indentation.
 *
 * Writes data to a temp file, then renames atomically so readers never see
 * a partial write. Accepts a string, a Buffer, or any JSON-serializable value.
 */

import { chmod, mkdir, stat, writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

const WIN_RETRY_ATTEMPTS = 5;
const WIN_RETRY_DELAY_MS = 10;
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
  // Read permissions before creating the temp so a restricted destination is
  // never replaced with a default-mode file. Only ENOENT means a fresh create.
  const existingMode = await stat(filePath).then((s) => s.mode & 0o777, (err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    // A failed write may already have produced partial bytes; cleanup owns the
    // entire preparation, including restoring mode bits tightened by umask.
    await writeFile(tmp, payload, existingMode !== null ? { mode: existingMode } : undefined);
    if (existingMode !== null) await chmod(tmp, existingMode);
    // Persistent Windows lock: fail without moving the destination aside.
    const err = await renameWithWindowsRetries(tmp, filePath);
    if (err) throw err;
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
