/**
 * Move a file into place WITHOUT ever replacing what is already there.
 *
 * `moveWithoutReplace(from, to)` publishes a staged file into its final name without clobbering an existing one (used by the rigging publication contract, `services/rigging/autoSkin.js`). `fs.rename` is the wrong primitive for a derived artifact (POSIX `rename(2)` silently clobbers, so a colliding second run destroys the first's output with no error); a collision is a BUG and should fail loudly with both files intact. Node exposes no `RENAME_NOREPLACE`, so this uses `link(2)` + `unlink(2)`: `link` fails atomically with `EEXIST` (no window with the destination absent) and the source is unlinked only after the link succeeds, so an interruption leaves the source rather than losing the bytes. Hard links need one filesystem that implements them; rather than degrade to a racy `stat`-then-`rename`, it FAILS with a named code (a caller wanting replacement calls `rename` itself). Stable `.code`s: `MOVE_DEST_EXISTS` (destination already published, never overwritten), `MOVE_CROSS_DEVICE` (different filesystems), `MOVE_NO_REPLACE_UNSUPPORTED` (filesystem can't express a no-replace move).
 */

import { link, unlink } from 'node:fs/promises';

/** A collision: the destination already exists and was NOT touched. */
export const MOVE_DEST_EXISTS = 'MOVE_DEST_EXISTS';
/** Source and destination live on different filesystems — stage inside the target dir. */
export const MOVE_CROSS_DEVICE = 'MOVE_CROSS_DEVICE';
/** The filesystem has no no-replace primitive; refusing rather than racing a rename. */
export const MOVE_NO_REPLACE_UNSUPPORTED = 'MOVE_NO_REPLACE_UNSUPPORTED';

// `link` reports "this filesystem does not do hard links" through several errnos by OS and mount (FAT/exFAT/SMB/some FUSE).
const UNSUPPORTED_ERRNOS = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EACCES']);

const fail = (code, message, cause) => {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

/**
 * Link `from` to `to`, then unlink `from`; never replaces an existing `to` (`from`: typically a file staged in a temp dir; `to`: its parent directory must exist; `io`: injectable fs seam for tests) → the destination path.
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
  // The bytes are already reachable at `to`; failing to drop the staged name leaves scratch but must not fail a completed publication.
  await unlinkImpl(from).catch((error) => {
    console.warn(`⚠️ Published ${to} but could not remove the staged copy ${from}: ${error.message}`);
  });
  return to;
}
