/**
 * Path containment and canonicalization: "is this path inside that directory" and "what path would the filesystem really act on".
 *
 * A dependency-free LEAF on purpose: the #6176 data-root guard reaches these from `fileCore.js`, which nearly every server suite imports; taking them from `pathSafety.js` would drag `errorHandler.js` and `paths.js` into that closure and push `importScoping.test.js`'s budget over its ceiling. Keep it free of imports beyond node builtins.
 * `pathSafety.js` keeps its own STRICT `isPathInsideDir` (the root is not "inside" itself, as file containment wants); separate declarations so this leaf stays unreachable from that module's consumers (only one case-folding expression is shared).
 */

import { realpathSync } from 'fs';
import { platform } from 'os';
import { basename, dirname, join, resolve as resolvePath, sep as PATH_SEP } from 'path';

const CASE_INSENSITIVE_FS = platform() === 'win32' || platform() === 'darwin';

/**
 * `pathSafety.js`'s `isPathInsideDir`, but the root itself also counts as inside: a guard refusing to WRITE anywhere in a tree must also refuse writing a file over the tree's own path. Case-folded on Windows/macOS like the strict form.
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
  // A filesystem or drive root ALREADY ends in the separator ('/', 'C:\\'), so appending one would anchor on '//' and report nothing inside.
  const prefix = root.endsWith(PATH_SEP) ? root : root + PATH_SEP;
  return target === root || target.startsWith(prefix);
}

/**
 * The path the filesystem would really act on: realpath of the deepest EXISTING ancestor plus the not-yet-created tail (`realpathSync` throws ENOENT on a path not yet created, i.e. every first write, and a nonexistent component can't be a symlink). Without it a symlinked ancestor
 * (`/tmp` → `/private/tmp` on macOS, a data dir symlinked onto another volume) compares unresolved and containment reads two spellings of one directory as two. Returns `resolved` unchanged when nothing along the chain resolves.
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
      // Native realpath also expands Windows short names, matching async filesystem callers rather than comparing two spellings of one temp root.
      const canonical = platform() === 'win32' ? realpathSync.native(existing) : realpathSync(existing);
      return join(canonical, ...tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolved; // hit the root; nothing resolved
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Compare two filesystem paths via `canonicalizePath`, returning `false` unless
 * both inputs are non-empty strings. Case-folded on Windows/macOS.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameCheckoutPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) {
    return false;
  }
  const a = canonicalizePath(left);
  const b = canonicalizePath(right);
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}
