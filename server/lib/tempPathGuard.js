/**
 * "Is this path really a throwaway?" guard for destructive test fixtures (#4554).
 *
 * Helpers that `git init`, `git config` or `rm -rf` a directory are safe only under `os.tmpdir()`, but an `undefined`, empty or relative path doesn't fail: `child_process.spawn` substitutes `process.cwd()`, so a fixture's `git init --bare` / `git config user.email test@test` landed on the developer's checkout (corrupting a live `.git/config`: `core.bare = true`, commits attributed to `test <test@test>`). These turn that silent fallback into a loud throw; three properties carry the guarantee: - The target is judged by its CANONICAL path (a symlink in the temp dir pointing at a real checkout is where the filesystem would operate). - `..` is refused outright, not modeled (`path.resolve` collapses it lexically, wrong once a symlinked ancestor is involved). - The target must be a STRICT descendant of the temp dir (`destroyGitSandbox(tmpdir())` would delete the whole system temp directory).
 */
import { tmpdir } from 'os';
import { isAbsolute, resolve, sep } from 'path';
import { canonicalizePath } from './pathContainment.js';

function tempRoots() {
  // Read `tmpdir()` on every call: TMPDIR is per-process env and tests stub it.
  const raw = resolve(tmpdir());
  return [...new Set([raw, canonicalizePath(raw)])];
}

// Windows paths compare case-insensitively; a TEMP env var in different casing than a resolved path would read as "not temp".
const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/** Strict descendant — deliberately NOT `child === parent`; see the header. */
function isStrictlyUnder(child, parent) {
  const c = comparable(child);
  const p = comparable(parent);
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`) && c.length > p.length;
}

/** True when `target` is an absolute path strictly inside the OS temp dir, after symlinks resolve; a non-string, empty, relative or `..`-bearing `target` is always false (shapes that would resolve against `process.cwd()` or climb out through a symlinked ancestor). */
export function isTempPath(target) {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) return false;
  if (target.split(/[\\/]+/).includes('..')) return false;
  const canonical = canonicalizePath(target);
  return tempRoots().some((root) => isStrictlyUnder(canonical, root));
}

/**
 * Throw unless `target` is a temp path; returns `target` so it wraps an argument inline: `await execGit(['init', repo], assertTempPath(scratch, 'git init'));`
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
