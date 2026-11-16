/**
 * Recognize and clear the `*.lock` files a KILLED git process leaves behind.
 *
 * Git guards each index/ref write with a lock file it removes on exit. A git
 * process that never gets to exit — PM2 tree-killing the server mid-update, an
 * `execGit` timeout firing, a reaped CoS agent — leaves the lock on disk, and
 * every later git command on that repo fails with:
 *
 *   fatal: Unable to create '<path>/index.lock': File exists.
 *   Another git process seems to be running in this repository…
 *
 * Nothing removes it, so the failure is PERMANENT until a human deletes a file
 * buried under `.git/`. The submodule case is the worst of them: the lock lives
 * in `.git/modules/<submodule>/`, which every git worktree of the repo shares,
 * so one dead process wedges submodule checkout for the primary checkout, every
 * CoS agent worktree, `update.sh`, and `npm run setup` at once — all of them
 * reporting a concurrent git process that does not exist.
 *
 * Deleting a lock a LIVE git process still holds would corrupt that write, so
 * `isStaleGitLock` clears one only when all three hold:
 *
 *   1. the path ends in `.lock` and sits under a `.git` directory. This is what
 *      keeps a malformed or attacker-shaped error message from aiming the
 *      unlink at a repository file — `yarn.lock` also ends in `.lock`, and it
 *      lives in the repo ROOT, outside `.git`.
 *   2. the file still exists (a concurrent retry may have already cleared it).
 *   3. its mtime is older than `STALE_GIT_LOCK_MIN_AGE_MS`. Git does not touch
 *      a lock's mtime while it works, so age is measured from lock CREATION;
 *      the threshold therefore has to exceed the longest git command PortOS can
 *      have in flight. The ceiling is `execGit`'s largest caller timeout (600s
 *      for `git worktree add`), after which the process is killed and its lock
 *      is stale by definition — 30 minutes leaves 3x headroom over that.
 *
 * Bare repos (`<name>.git/index.lock`, no `.git` path segment) are deliberately
 * out of scope: PortOS creates them only as test fixtures, never on a path that
 * needs this rescue.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { scrubHomePath } from './homePath.js';

/** See rule 3 above — 3x the longest git command PortOS can have in flight. */
export const STALE_GIT_LOCK_MIN_AGE_MS = 30 * 60 * 1000;

// Git quotes the offending path in every wording that reports lock contention
// ("Unable to create '<path>': File exists", "cannot lock ref '…': Unable to
// create '<path>'"). Anchoring on the quoted `.lock` path rather than on the
// sentence keeps this working across git's phrasings and locales-in-English.
const QUOTED_LOCK_PATH = /'([^']*\.lock)'/;

/**
 * The lock path a git error names, or null when the message reports something
 * other than lock contention.
 * @param {string} message - git stderr / Error message
 * @returns {string|null}
 */
export function gitLockPathFromError(message) {
  if (typeof message !== 'string') return null;
  return message.match(QUOTED_LOCK_PATH)?.[1] ?? null;
}

/**
 * True when `lockPath` is a git lock file left behind by a process that is gone.
 *
 * The threshold is deliberately NOT a parameter: this predicate is the only
 * thing standing between a caller and an unlink, and an injectable `minAgeMs`
 * is an argument away from `0` — a caller that deletes whatever lock the error
 * named, live process or not. Tests back-date a real lock's mtime instead.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
export function isStaleGitLock(lockPath) {
  if (typeof lockPath !== 'string' || !lockPath.endsWith('.lock')) return false;
  // Accept both separators: a Windows git reports backslash paths, and a POSIX
  // path can reach a Windows Node through a checked-in fixture or a log.
  if (!lockPath.split(/[\\/]/).includes('.git')) return false;
  // One guarded stat rather than existsSync + statSync: the gap between those
  // two is a race this module actively creates — a concurrent retry (or git
  // itself) removing the lock in the window would throw ENOENT out of a
  // predicate whose callers are handling a git failure, replacing the real
  // error with a confusing one. An unreadable lock answers "not stale" too:
  // this may not throw, and nothing can be proven about a lock it can't stat.
  const mtimeMs = statMtimeMs(lockPath);
  return mtimeMs !== null && Date.now() - mtimeMs >= STALE_GIT_LOCK_MIN_AGE_MS;
}

/** A path's mtime, or null when it is missing or cannot be read. */
function statMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Clear the stale lock a failed git command named, so the caller can retry.
 *
 * Returns the removed path (for the caller's log line) or null when there was
 * nothing safe to remove — no lock in the message, a lock too young to call
 * abandoned, or one another retry already cleared. Never throws: a failed
 * rescue must surface as the ORIGINAL git error, not as an unlink error that
 * hides it.
 *
 * @param {string} message - git stderr / Error message from the failed command
 * @returns {string|null} the lock path that was removed
 */
export function clearStaleGitLock(message) {
  const lockPath = gitLockPathFromError(message);
  if (!lockPath || !isStaleGitLock(lockPath)) return null;
  try {
    unlinkSync(lockPath);
  } catch {
    return null;
  }
  // Segments below `.git/` name repository internals, never user records, but
  // the absolute prefix embeds the OS username — scrub it rather than trim a
  // fixed depth, which keeps `/Users/<name>` for a repo checked out shallowly.
  console.log(`🧹 Cleared stale git lock: ${scrubHomePath(lockPath)}`);
  return lockPath;
}

// `objects/` holds tens of thousands of entries and none of the locks that
// wedge a checkout (index, refs, packed-refs, and each submodule's copies of
// those under `modules/`), so walking it would dominate the sweep's cost for
// nothing. `rr-cache/` is rerere state, likewise not in the wedge path.
const UNSWEPT_GIT_DIRS = new Set(['objects', 'rr-cache']);

/**
 * Sweep a repository's git directory for abandoned locks, BEFORE running the
 * commands that would trip over them.
 *
 * The reactive form above only helps a caller that gets to see the failure and
 * retry. `update.sh` / `update.ps1` are the most likely PRODUCER of an
 * abandoned lock in the first place — PM2 tree-kills the server mid-update and
 * takes the `git submodule update` subprocess with it — and, before this, had
 * no recovery at all: every later self-update failed the same way, on a lock
 * only a human could find. They call this first so the update that follows
 * starts from a clean repo.
 *
 * Same three-condition rule as `isStaleGitLock`, so there is ONE definition of
 * "abandoned" rather than a second copy in shell.
 *
 * @param {string} gitDir - the repository's git directory (`<repo>/.git`)
 * @returns {string[]} the lock paths removed
 */
export function clearStaleGitLocksIn(gitDir) {
  const root = resolveCommonGitDir(gitDir);
  if (!root) return [];
  const cleared = [];
  const walk = (dir) => {
    // A directory git removes mid-walk (gc pruning its temp dirs), or one this
    // process cannot read, must not abort the whole sweep — this runs ahead of
    // the self-update, where throwing would be a worse outcome than missing a
    // lock. Skip the subtree and keep going.
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!UNSWEPT_GIT_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith('.lock') && isStaleGitLock(full)) {
        try {
          unlinkSync(full);
          cleared.push(full);
          console.log(`🧹 Cleared stale git lock: ${scrubHomePath(full)}`);
        } catch {
          // Best effort — an unreadable lock is the caller's original problem
          // to report, not a reason to abort the update before it starts.
        }
      }
    }
  };
  walk(root);
  return cleared;
}

/**
 * Resolve a `.git` path to the SHARED git directory whose locks actually wedge
 * things, or null when it names no repository.
 *
 * Two indirections have to be followed, and both matter here:
 *   - in a git WORKTREE (every CoS agent runs in one), `.git` is a FILE holding
 *     `gitdir: <path>` — reading it as a directory is the difference between
 *     sweeping and throwing;
 *   - that per-worktree git dir holds only its own HEAD/index locks. The locks
 *     shared by every worktree — `modules/<submodule>/index.lock`, the refs —
 *     live in the COMMON dir, which git names in a `commondir` file beside it.
 *     Sweeping the worktree's own dir would miss the exact lock this module
 *     exists for.
 */
function resolveCommonGitDir(gitPath) {
  if (typeof gitPath !== 'string' || !existsSync(gitPath)) return null;
  let pointer = gitPath;
  if (!statSync(gitPath).isDirectory()) {
    // A `.git` file that names no gitdir is not a repository. Returning the
    // file's own directory here would resolve to the WORKING TREE and walk the
    // whole checkout looking for locks.
    const target = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(\S.*)$/m)?.[1].trim();
    if (!target) return null;
    pointer = resolve(dirname(gitPath), target);
  }
  if (!existsSync(pointer) || !statSync(pointer).isDirectory()) return null;
  const commondir = join(pointer, 'commondir');
  return existsSync(commondir)
    ? resolve(pointer, readFileSync(commondir, 'utf8').trim())
    : pointer;
}
