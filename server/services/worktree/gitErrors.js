/** Git worktree error classification and bounded mutation retry. */

import { sleep } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { clearStaleGitLock } from '../../lib/gitStaleLock.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';

// `git worktree add` lock-contention retry (#2193). Git guards a repo's
// worktree bookkeeping (`.git/worktrees`, `.git/index.lock`) with a per-repo
// lock, so two adds fired in the same evaluation tick race — the loser fails
// with a lock error. Serialization (queueWorktreeCreate) removes the common
// same-process race; retry handles residual external contention (a human
// `git` command, another install's tool touching a shared checkout).
const WORKTREE_ADD_MAX_ATTEMPTS = 4;

const WORKTREE_ADD_RETRY_DELAY_MS = 250;

// `git worktree add` materializes a FULL checkout, so it is nothing like the
// metadata reads execGit's 30s default was sized for: ~5.8k files here, and on
// Windows every one of them is written through the AV filter driver, which puts
// a cold add well past 30s. Worse, the timeout doesn't stop git — the checkout
// keeps running and lands — so PortOS blocks the task with `worktree-failed`
// while the worktree and branch it just gave up on exist on disk, which then
// defeats the orphan-branch cleanup ("Cannot delete branch … checked out at …").
// Ten minutes is far above any healthy add and still bounded. Applies to
// `worktree move` too — it routes through this same wrapper. Removal also
// deletes the full checkout (including ignored output), so it uses this ceiling
// to avoid leaving a partially deleted tree when the metadata timeout expires.
//
// EXPORTED because it is the ceiling `STALE_GIT_LOCK_MIN_AGE_MS` is sized
// against: the longest a git command PortOS launches can legitimately still be
// holding its lock. Raising this without raising that one would let the
// stale-lock sweep delete a live checkout's lock — the test below pins it.
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * True when a git error message indicates lock/contention on the worktree or
 * index lock (as opposed to a genuine, non-retryable failure like a bad ref,
 * a pre-existing branch, or an existing worktree path — retrying those just
 * wastes the retry budget and spams misleading "lock contention" logs, #2193).
 * Deliberately does NOT match bare "File exists" / "already exists": the
 * canonical lock error is `Unable to create '…/index.lock': File exists`
 * (caught by `index.lock`), whereas `a branch named 'X' already exists` and
 * `'<path>' already exists` are permanent. Exported for unit testing against
 * real git lock-error wording.
 *
 * The "unable to create" alternative is anchored to a quoted `.lock` path on
 * purpose. A bare `unable to create` also matches git's PER-FILE checkout
 * failure, `error: unable to create file <path>: Permission denied` — exactly
 * what a Windows AV filter driver produces mid-checkout. That is not lock
 * contention and does not clear on retry, but it IS reached only after git has
 * written most of the tree, so matching it spent the whole retry budget on
 * repeated full checkouts: with WORKTREE_ADD_TIMEOUT_MS that is 4 × 10 min of
 * head-of-line blocking on the per-repo queue for a permanent failure. The
 * retry budget is sized for bookkeeping-lock failures, which fail in
 * milliseconds.
 */
export function isGitLockError(message) {
  return /index\.lock|cannot lock|could not lock|unable to create '[^']*\.lock'|unable to (?:write|lock)|already locked|another git process/i.test(message || '');
}

/**
 * True when `git worktree add` refused because the branch is ALREADY checked out
 * in some other worktree — `fatal: '<branch>' is already used by worktree at
 * '<path>'` on current git, `is already checked out at '<path>'` on older ones.
 *
 * This is a TRANSIENT condition, not a misconfiguration: the only routine
 * producer is a cleanup still tearing down the previous agent's worktree while
 * the follow-up spawned to land its PR is already prepping (the two ran ~0.7s
 * apart in the incident that motivated this). Callers use it to pause and retry
 * rather than blocking the task, which stranded the pull request the follow-up
 * existed to merge.
 *
 * Deliberately NOT folded into `isGitLockError`: that predicate drives the
 * in-process add retry, whose budget is sized in milliseconds for bookkeeping
 * locks. Waiting out another worktree's teardown belongs at the task level.
 */
export function isBranchCheckedOutElsewhereError(message) {
  return /already (?:used by worktree|checked out) at/i.test(message || '');
}

/**
 * Run `git worktree add …` with retry on lock contention. Promise-chained
 * (no try/catch) so it stays idiomatic with the rest of the module: on a lock
 * error it backs off and recurses until WORKTREE_ADD_MAX_ATTEMPTS, then lets
 * the final error reject. Non-lock errors (bad base ref, etc.) reject
 * immediately — retrying them just wastes time.
 *
 * The FIRST attempt's error is preserved on the final rejection as
 * `err.firstAttemptError` so orphan-branch cleanup can reason about the
 * ORIGINAL failure cause: a `-b` add that created the branch and then hit a
 * lock error would fail attempt 2 with a retry-induced `branch already
 * exists`, and cleanup must NOT mistake that for "the branch pre-dated us"
 * (#2193) — the branch is exactly the orphan it needs to delete.
 */
export async function addWorktreeWithRetry(args, repo, attempt = 1, firstError = null) {
  return withGitMutationLifetime(() => addWorktreeAdmitted(args, repo, attempt, firstError));
}

function addWorktreeAdmitted(args, repo, attempt, firstError) {
  return execGit(args, repo, { timeout: WORKTREE_ADD_TIMEOUT_MS }).catch((err) => {
    const originalError = firstError || err;
    if (attempt >= WORKTREE_ADD_MAX_ATTEMPTS || !isGitLockError(err.message)) {
      err.firstAttemptError = originalError;
      throw err;
    }
    // The retry budget above assumes CONTENTION — a live competitor that will
    // release the lock within a second. An ABANDONED lock (a killed git process
    // never removed it) releases never, so all four attempts fail and the task
    // blocks with `worktree-failed` on a repo nothing is actually using. Clear
    // it before backing off; `clearStaleGitLock` refuses anything young enough
    // to still belong to a running command, so a real competitor is untouched.
    clearStaleGitLock(err.message);
    console.log(`🌳 Worktree ${args[1] || 'add'} lock contention (attempt ${attempt}/${WORKTREE_ADD_MAX_ATTEMPTS}), retrying in ${WORKTREE_ADD_RETRY_DELAY_MS}ms: ${err.message}`);
    return sleep(WORKTREE_ADD_RETRY_DELAY_MS)
      .then(() => addWorktreeWithRetry(args, repo, attempt + 1, originalError));
  });
}

/**
 * A git error saying the target BRANCH already exists (`fatal: a branch named
 * 'X' already exists`) — a permanent precondition failure meaning the ref
 * PRE-DATED this add and git created nothing, so it is NOT an orphan this add
 * left behind. cleanupOrphanBranch keys off this to avoid `git branch -D`-ing
 * a branch it didn't create (#2193).
 *
 * Deliberately NARROW: it must NOT match `'<path>' already exists` (the
 * worktree DIRECTORY was occupied), because in that case `git worktree add -b`
 * has ALREADY created the branch before failing on the path — so that branch
 * IS an orphan and must be cleaned up. Only the branch-named wording is safe
 * to skip on.
 */
export function isPreexistingRefError(message) {
  return /branch (?:named )?['`]?[^'`\n]*['`]? ?already exists/i.test(message || '');
}
