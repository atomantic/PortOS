/**
 * Atomic file write helper for the aiToolkit.
 *
 * Duplicated from server/lib/fileUtils.js so the toolkit stays self-contained
 * (no imports out to sibling PortOS modules). Keep in sync with upstream.
 *
 * Writes data to a temp file, then renames atomically so readers never see
 * a partial write. Accepts a string or any JSON-serializable value.
 */

import { mkdir, writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function atomicWrite(filePath, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, payload);
  const replace = async () => {
    const err = await rename(tmp, filePath).then(() => null, (e) => e);
    if (!err) return;
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EEXIST'].includes(err.code)) {
      const bak = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
      const hadExisting = await rename(filePath, bak).then(() => true, (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      });
      const renameErr = await rename(tmp, filePath).then(() => null, (e) => e);
      if (renameErr) {
        if (hadExisting) await rename(bak, filePath).catch(() => {});
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
