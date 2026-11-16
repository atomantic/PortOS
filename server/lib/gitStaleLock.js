/**
 * Recognize and clear the `*.lock` files a KILLED git process leaves behind (PM2 tree-killing the server
 * mid-update, an `execGit` timeout, a reaped CoS agent).
 *
 * Nothing else removes them, so every later git command fails with "Unable to create '<path>/index.lock': File
 * exists" until a human deletes it. A submodule lock lives in `.git/modules/<submodule>/`, shared by every
 * worktree, so one dead process wedges the primary checkout, all CoS worktrees, `update.sh` and `npm run setup`.
 *
 * Deleting a lock a LIVE git holds would corrupt its write, so `isStaleGitLock` clears one only when:
 *
 *   1. the path ends in `.lock` and sits under a `.git` directory (keeps a malformed or
 *      attacker-shaped error message from aiming the unlink at e.g. a root `yarn.lock`).
 *   2. the file still exists (a concurrent retry may have cleared it).
 *   3. its mtime is older than `STALE_GIT_LOCK_MIN_AGE_MS`. Git doesn't touch a lock's mtime while it
 *      works, so age runs from CREATION and must exceed the longest git command in flight
 *      (`execGit`'s largest caller timeout, 600s for `git worktree add`); 30 minutes is 3x headroom.
 *
 * Bare repos (`<name>.git/index.lock`) are out of scope: PortOS only creates them as test fixtures.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { scrubHomePath } from './homePath.js';

/** See rule 3 above — 3x the longest git command PortOS can have in flight. */
export const STALE_GIT_LOCK_MIN_AGE_MS = 30 * 60 * 1000;

// Git quotes the offending path in every lock-contention wording; anchoring on the quoted `.lock`
// path rather than the sentence survives git's phrasings.
const QUOTED_LOCK_PATH = /'([^']*\.lock)'/;

/**
 * The lock path a git error names, or null when the message isn't lock contention.
 *
 * @param {string} message - git stderr / Error message
 * @returns {string|null}
 */
export function gitLockPathFromError(message) {
  if (typeof message !== 'string') return null;
  return message.match(QUOTED_LOCK_PATH)?.[1] ?? null;
}

/**
 * True when `lockPath` is a git lock left behind by a process that is gone. The threshold is
 * deliberately NOT a parameter: this predicate is all that stands between a caller and an unlink, and
 * an injectable `minAgeMs` is one argument from `0`. Tests back-date a real lock's mtime instead.
 *
 * @param {string} lockPath
 */
export function isStaleGitLock(lockPath) {
  if (typeof lockPath !== 'string' || !lockPath.endsWith('.lock')) return false;
  // Both separators: a Windows git reports backslash paths, and a POSIX path can reach Windows Node via fixtures/logs.
  if (!lockPath.split(/[\\/]/).includes('.git')) return false;
  // One guarded stat, not existsSync + statSync: a concurrent removal in that gap would throw ENOENT
  // out of a predicate whose callers are handling a git failure. An unreadable lock answers "not stale".
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
 * Clear the stale lock a failed git command named so the caller can retry. Returns the removed path
 * or null when nothing safe was removable. Never throws: a failed rescue must surface as the ORIGINAL
 * git error, not an unlink error hiding it.
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
  // Scrub the OS username from the absolute prefix rather than trim a fixed depth (a shallow checkout keeps `/Users/<name>`).
  console.log(`🧹 Cleared stale git lock: ${scrubHomePath(lockPath)}`);
  return lockPath;
}

// `objects/` holds tens of thousands of entries and none of the wedging locks; `rr-cache/` is rerere
// state. Walking them would dominate the sweep's cost.
const UNSWEPT_GIT_DIRS = new Set(['objects', 'rr-cache']);

/**
 * Sweep a git directory for abandoned locks BEFORE running the commands that would trip over them.
 * `update.sh` / `update.ps1` call this first: PM2 tree-killing the server mid-update is the likeliest
 * producer of an abandoned lock, and the reactive form above can't help a caller that never sees the
 * failure. Same three-condition rule as `isStaleGitLock`, so "abandoned" has one definition.
 *
 * @param {string} gitDir - the repository's git directory (`<repo>/.git`)
 * @returns {string[]} the lock paths removed
 */
export function clearStaleGitLocksIn(gitDir) {
  const root = resolveCommonGitDir(gitDir);
  if (!root) return [];
  const cleared = [];
  const walk = (dir) => {
    // A directory git removes mid-walk or one we can't read must not abort the sweep (it runs ahead of
    // self-update, where throwing is worse than missing a lock); skip the subtree.
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
          // Best effort: an unreadable lock is the caller's original problem to report.
        }
      }
    }
  };
  walk(root);
  return cleared;
}

/**
 * Resolve a `.git` path to the SHARED git directory whose locks wedge things, or null if it names no
 * repository. Two indirections: in a git WORKTREE (every CoS agent) `.git` is a FILE holding
 * `gitdir: <path>`; and that per-worktree dir holds only its own HEAD/index locks, while the shared
 * `modules/<submodule>/index.lock` and refs live in the COMMON dir named by its `commondir` file.
 */
function resolveCommonGitDir(gitPath) {
  if (typeof gitPath !== 'string' || !existsSync(gitPath)) return null;
  let pointer = gitPath;
  if (!statSync(gitPath).isDirectory()) {
    // A `.git` file naming no gitdir isn't a repository; falling back to its directory would walk the whole working tree.
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
