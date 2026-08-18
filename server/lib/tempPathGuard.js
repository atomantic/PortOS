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
 * These helpers turn that silent fallback into a loud throw: resolve the target
 * and refuse anything that is not an absolute path under the OS temp dir.
 * Both the raw `os.tmpdir()` and its realpath count as roots, because macOS
 * reports `/var/folders/...` while `realpath` yields `/private/var/folders/...`.
 */
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, resolve, sep } from 'path';

const realpathOrSelf = (candidate) => {
  try {
    return realpathSync(candidate);
  } catch {
    // Not created yet (a fixture's `scratch/primary`) — the resolved path is
    // the best answer we have, and its temp-ness is decided by its ancestors.
    return candidate;
  }
};

function tempRoots() {
  // Read `tmpdir()` on every call: TMPDIR is per-process env, and tests stub it.
  const raw = resolve(tmpdir());
  const real = realpathOrSelf(raw);
  return real === raw ? [raw] : [raw, real];
}

const isUnder = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * True when `target` is an absolute path inside the OS temp dir.
 * A non-string, empty, or relative `target` is always false — those are the
 * shapes that would otherwise be resolved against `process.cwd()`.
 */
export function isTempPath(target) {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) return false;
  const resolved = resolve(target);
  const candidates = resolved === realpathOrSelf(resolved)
    ? [resolved]
    : [resolved, realpathOrSelf(resolved)];
  return tempRoots().some((root) => candidates.some((candidate) => isUnder(candidate, root)));
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
    + 'Test git fixtures must target a directory created under os.tmpdir(); '
    + 'a missing or relative path would fall back to process.cwd() and mutate the real checkout.',
  );
}
