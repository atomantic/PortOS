/**
 * Path containment and canonicalization — the questions "is this path inside
 * that directory" and "what path would the filesystem really act on".
 *
 * A dependency-free LEAF on purpose. The #6176 data-root guard reaches these
 * from `fileCore.js`, which essentially every server suite imports — taking
 * them from `pathSafety.js` instead would drag `errorHandler.js` and `paths.js`
 * into that closure and push `importScoping.test.js`'s tree-wide budget over its
 * ceiling. Keep this module free of imports beyond node builtins.
 *
 * `pathSafety.js` keeps its own `isPathInsideDir` — the STRICT form, where the
 * root is not "inside" itself, which is what file containment wants. The two
 * are separate declarations rather than one importing the other precisely so
 * this leaf stays unreachable from that module's consumers; the shared part is
 * one case-folding expression, not the subtle part. A flat-barrel name
 * collision would also force a namespace export on one of them.
 */

import { realpathSync } from 'fs';
import { platform } from 'os';
import { basename, dirname, join, resolve as resolvePath, sep as PATH_SEP } from 'path';

const CASE_INSENSITIVE_FS = platform() === 'win32' || platform() === 'darwin';

/**
 * `pathSafety.js`'s `isPathInsideDir`, but the root itself also counts as inside.
 *
 * File containment wants the strict form — a directory is not one of the files
 * in it. A guard that refuses to WRITE anywhere in a tree wants this one:
 * writing a file over the tree's own path is no more acceptable than writing
 * under it. Case-folded on Windows/macOS for the same reason the strict form is.
 *
 * @param {string} dir - the containing directory
 * @param {string} candidatePath - the path to test
 * @returns {boolean}
 */
export function isPathAtOrInsideDir(dir, candidatePath) {
  if (typeof dir !== 'string' || typeof candidatePath !== 'string' || !dir || !candidatePath) {
    return false;
  }
  const fold = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const root = fold(resolvePath(dir));
  const target = fold(resolvePath(candidatePath));
  // A filesystem or drive root ALREADY ends in the separator ('/', 'C:\\'), so
  // appending one would anchor on '//' and report nothing as inside it.
  const prefix = root.endsWith(PATH_SEP) ? root : root + PATH_SEP;
  return target === root || target.startsWith(prefix);
}

/**
 * The path the filesystem would really act on: realpath of the deepest
 * EXISTING ancestor, plus the not-yet-created tail. `realpathSync` throws
 * ENOENT on a path that has not been created yet — which is every first write
 * to a destination — and a component that does not exist cannot be a symlink,
 * so resolving the ancestor and re-attaching the tail is both safe and the
 * only form that works before the target exists.
 *
 * Without it a symlinked ancestor (`/tmp` → `/private/tmp` on macOS, or a
 * data dir symlinked onto another volume) compares unresolved, and a
 * containment check reads two spellings of one directory as two directories.
 *
 * Returns `resolved` unchanged when nothing along the chain resolves.
 *
 * @param {string} target - path to canonicalize (resolved to absolute first)
 * @returns {string}
 */
export function canonicalizePath(target) {
  const resolved = resolvePath(target);
  const tail = [];
  let existing = resolved;
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolved; // hit the root; nothing resolved
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}
