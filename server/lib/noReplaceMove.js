/**
 * Move a file into place WITHOUT ever replacing what is already there.
 *
 * `fs.rename` is the wrong primitive for publishing a derived artifact: POSIX
 * `rename(2)` silently clobbers an existing destination, so a second run that
 * collides on a name destroys the first run's output with no error to report. What a
 * publication step wants is the opposite default — a collision is a BUG, and the
 * correct response is to fail loudly and leave both files intact.
 *
 * Node exposes no `RENAME_NOREPLACE` flag, so the portable POSIX way to get that
 * guarantee is `link(2)` + `unlink(2)`: `link` fails atomically with `EEXIST` when the
 * destination exists, and there is no window in which the destination is absent. The
 * source is unlinked only after the link succeeds, so an interruption leaves the
 * source in place rather than losing the bytes.
 *
 * Hard links only exist within one filesystem and only on filesystems that implement
 * them. Rather than degrading to a `stat`-then-`rename` (which is a race — another
 * writer can create the destination between the two calls, and `rename` would then
 * eat it), this FAILS with a named code. A caller that genuinely wants replacement
 * should call `rename` itself and say so.
 *
 * Errors carry a stable `.code` so callers can branch without string matching:
 *   `MOVE_DEST_EXISTS`      — the destination is already published (never overwritten)
 *   `MOVE_CROSS_DEVICE`     — source and destination are on different filesystems
 *   `MOVE_NO_REPLACE_UNSUPPORTED` — this filesystem cannot express a no-replace move
 */

import { link, unlink } from 'node:fs/promises';

/** A collision: the destination already exists and was NOT touched. */
export const MOVE_DEST_EXISTS = 'MOVE_DEST_EXISTS';
/** Source and destination live on different filesystems — stage inside the target dir. */
export const MOVE_CROSS_DEVICE = 'MOVE_CROSS_DEVICE';
/** The filesystem has no no-replace primitive; refusing rather than racing a rename. */
export const MOVE_NO_REPLACE_UNSUPPORTED = 'MOVE_NO_REPLACE_UNSUPPORTED';

// `link` reports "this filesystem does not do hard links" through several different
// errnos depending on the OS and the mount (FAT/exFAT/SMB/some FUSE mounts).
const UNSUPPORTED_ERRNOS = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EACCES']);

const fail = (code, message, cause) => {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

/**
 * Link `from` to `to`, then unlink `from`. Never replaces an existing `to`.
 *
 * @param {string} from Source path (typically a file staged in a temp dir).
 * @param {string} to Destination path. Its parent directory must already exist.
 * @param {{linkImpl?: Function, unlinkImpl?: Function}} [io] Injectable fs seam for tests.
 * @returns {Promise<string>} The destination path.
 */
export async function moveWithoutReplace(from, to, { linkImpl = link, unlinkImpl = unlink } = {}) {
  await linkImpl(from, to).catch((error) => {
    if (error?.code === 'EEXIST') {
      throw fail(MOVE_DEST_EXISTS, `Refusing to replace an existing file: ${to}`, error);
    }
    if (error?.code === 'EXDEV') {
      throw fail(MOVE_CROSS_DEVICE, `Cannot publish across filesystems: ${from} → ${to}`, error);
    }
    if (UNSUPPORTED_ERRNOS.has(error?.code)) {
      throw fail(
        MOVE_NO_REPLACE_UNSUPPORTED,
        `This filesystem cannot move a file without risking a replace (${error.code}): ${to}`,
        error,
      );
    }
    throw error;
  });
  // The bytes are already reachable at `to`; a failure to drop the staged name leaves
  // scratch behind but must not fail a completed publication.
  await unlinkImpl(from).catch((error) => {
    console.warn(`⚠️ Published ${to} but could not remove the staged copy ${from}: ${error.message}`);
  });
  return to;
}
