/**
 * Path containment for a PortOS-owned Blender workspace (a film's or a model's):
 * the refusal every workspace route answers with, and the check that a path
 * sits inside its root with no symlink on the way. Neither a request nor a link
 * an authored script left behind can aim a read, write or delete outside it.
 * Path math and `lstat` only: nothing here runs a process.
 */
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';

export const blenderRefusal = (message, code, status = 400, context = null) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

/**
 * Refuse `absolute` unless it sits inside `root` and no existing component from
 * `root` down is a symlink. A component that does not exist yet is fine: the
 * caller is about to create it.
 */
export async function assertInsideWithoutSymlinks(root, absolute) {
  if (!isPathInsideDir(root, absolute)) throw blenderRefusal('That path is outside the Blender workspace', 'MUSIC_VIDEO_BLENDER_PATH');
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of [null, ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw blenderRefusal('Symbolic links are not followed inside the Blender workspace', 'MUSIC_VIDEO_BLENDER_PATH');
  }
}
