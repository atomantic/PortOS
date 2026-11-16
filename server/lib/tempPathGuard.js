/**
 * "Is this path really a throwaway?" guard for destructive test fixtures (#4554).
 *
 * Test helpers that `git init`, `git config`, or `rm -rf` a directory are only
 * safe because that directory lives under `os.tmpdir()`. When the path they are
 * handed is `undefined`, empty, or relative, the underlying primitive does not
 * fail — `child_process.spawn` silently substitutes `process.cwd()`, so a
 * fixture's `git init --bare` / `git config user.email test@test` lands on the
 * developer's real checkout. That is exactly how a server-suite run corrupted a
 * live `.git/config` (`core.bare = true`, commits re-attributed to
 * `test <test@test>`).
 *
 * These helpers turn that silent fallback into a loud throw. Three properties
 * carry the whole guarantee, and none of them is optional:
 *
 *  - The target is judged by its CANONICAL path, not its spelling. A symlink
 *    sitting inside the temp dir and pointing at a real checkout is where the
 *    filesystem would actually operate, so that is what gets checked.
 *  - `..` is refused outright rather than modeled — `path.resolve` collapses it
 *    lexically, which is the wrong answer the moment a symlinked ancestor is
 *    involved.
 *  - The target must be a STRICT descendant of the temp dir. `os.tmpdir()`
 *    itself is not an acceptable target: `destroyGitSandbox(tmpdir())` would
 *    recursively delete the whole system temp directory.
 */
import { tmpdir } from 'os';
import { isAbsolute, resolve, sep } from 'path';
import { canonicalizePath } from './pathContainment.js';

function tempRoots() {
  // Read `tmpdir()` on every call: TMPDIR is per-process env, and tests stub it.
  const raw = resolve(tmpdir());
  return [...new Set([raw, canonicalizePath(raw)])];
}

// Windows paths compare case-insensitively, and a TEMP env var spelled with
// different casing than a resolved path would otherwise read as "not temp".
const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/** Strict descendant — deliberately NOT `child === parent`; see the header. */
function isStrictlyUnder(child, parent) {
  const c = comparable(child);
  const p = comparable(parent);
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`) && c.length > p.length;
}

/**
 * True when `target` is an absolute path strictly inside the OS temp dir, after
 * symlinks are resolved. A non-string, empty, relative, or `..`-bearing
 * `target` is always false — those are the shapes that would otherwise be
 * resolved against `process.cwd()` or climb out through a symlinked ancestor.
 */
export function isTempPath(target) {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) return false;
  if (target.split(/[\\/]+/).includes('..')) return false;
  const canonical = canonicalizePath(target);
  return tempRoots().some((root) => isStrictlyUnder(canonical, root));
}

/**
 * Throw unless `target` is a temp path. Returns `target` so it can wrap an
 * argument inline: `await execGit(['init', repo], assertTempPath(scratch, 'git init'));`
 *
 * @param {string} target - directory a destructive fixture operation will run against
 * @param {string} operation - what is about to run, for the error message
 * @returns {string} target
 */
export function assertTempPath(target, operation = 'this operation') {
  if (isTempPath(target)) return target;
  throw new Error(
    `❌ refusing to run ${operation} outside ${tmpdir()} — got ${JSON.stringify(target)}. `
    + 'Test git fixtures must target a directory created UNDER os.tmpdir() (the temp dir '
    + 'itself, a relative or `..`-bearing path, and a symlink out of the temp dir are all '
    + 'refused); anything else would mutate the real checkout.',
  );
}
