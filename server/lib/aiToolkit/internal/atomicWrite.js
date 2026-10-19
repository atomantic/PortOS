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
 * The temp file is fsynced before the rename and the directory after it
 * (#12025), so a crash cannot leave the rename durable without its bytes.
 */

import { chmod, mkdir, open, stat, writeFile, rename, unlink } from 'fs/promises';
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

// Directories whose fsync already failed once this process, so a filesystem
// that rejects directory fsync (EINVAL on some network mounts) warns once
// instead of on every write.
const unsyncableDirs = new Set();

/**
 * fsync a directory so a just-completed rename inside it survives a crash.
 * Best-effort once the rename is visible: the bytes are already in place, so a
 * filesystem that cannot sync its directory degrades to the pre-#12025
 * guarantee with one warning rather than failing a write that succeeded.
 * Windows cannot open a directory for fsync, so it is skipped there.
 */
async function syncDirectory(dir) {
  if (isWindows()) return;
  try {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    if (!err?.code) throw err;
    if (unsyncableDirs.has(dir)) return;
    unsyncableDirs.add(dir);
    console.warn(`⚠️ Directory fsync unavailable for ${dir} (${err.code}); renames there are not crash-durable`);
  }
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
    // `flush` fsyncs the temp file's bytes before the handle closes.
    await writeFile(tmp, payload, { ...(existingMode !== null ? { mode: existingMode } : {}), flush: true });
    if (existingMode !== null) await chmod(tmp, existingMode);
    // Persistent Windows lock: fail without moving the destination aside.
    const err = await renameWithWindowsRetries(tmp, filePath);
    if (err) throw err;
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDirectory(dirname(filePath));
}
