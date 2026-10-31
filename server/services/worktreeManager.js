/**
 * Git Worktree Manager
 *
 * Creates and cleans up git worktrees for CoS agents that need isolated
 * workspaces to avoid file conflicts with concurrent agents.
 *
 * Worktrees are created under data/cos/worktrees/<agentId>/ with a
 * unique branch name. On agent completion, the worktree is removed
 * and the branch cleaned up.
 */

import { claimBranchAdmission, claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { existsSync, realpathSync } from 'fs';
import { lstat, readlink, readdir, rm, stat, symlink, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { ensureDir, isPathInsideDir, PATHS, sleep, tryReadFile } from '../lib/fileUtils.js';
import { DONE_SENTINEL_NAME, doneSentinelCandidateNames } from '../lib/agentSentinel.js';
import { AGENT_SCRATCH_PATHS, matchesScratchRoot } from '../lib/agentScratchPaths.js';
import { execGit } from '../lib/execGit.js';
import { hasProcessCwdInside } from '../lib/processCwdProbe.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { clearStaleGitLock } from '../lib/gitStaleLock.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { enforceSafeBranchUpstream } from '../lib/branchUpstreamGuard.js';
import { forkRemoteName, normalizeForkHead, forkLocalBranch } from '../lib/forkHead.js';
import { isHumanClaimWorktree, worktreeAgentId, worktreeOwnershipReason } from '../lib/worktreeOwnership.js';
import { ensureInstanceId } from './instanceIdentity.js';
import { provisionWorkspaceNodeModules, removeProvisionedNodeModules } from '../lib/worktreeNodeModules.js';

export { isHumanClaimWorktree } from '../lib/worktreeOwnership.js';

const WORKTREES_DIR = PATHS.worktrees;
const CACHE_ENTRIES = new Set(['.vite', '.vitest-cache', '.cache']);
// `git worktree list --porcelain` reports POSIX separators on every platform —
// `H:/repo/data/cos/worktrees/agent-x` — while WORKTREES_DIR is built with
// `join` and is backslash-separated on Windows. So a git-reported path is never
// compared with a bare `startsWith`/`split('/')`: `isPathInsideDir` resolves
// both sides first (and rejects a sibling like `worktrees-old`), and
// `worktreeAgentId()` treats either separator as one. Before this, every CoS
// worktree failed the containment check on Windows — `cleanupOrphanedWorktrees`
// skipped them all and `reapMergedWorktrees` filed them as `unmanaged-location`,
// so the daily line read "reaped 0 merged + 0 orphaned" with orphans on disk.
// Lockfiles that npm/yarn/pnpm modify as a side-effect — safe to discard during worktree cleanup
const AUTO_GENERATED_LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
// Cap the dirty paths named in a "worktree preserved" warning — the message ends
// up in a notification and on the agent card, and a broad sweep can dirty
// hundreds of files. Enough to identify the work, short enough to read.
const DIRT_PATHS_IN_WARNING = 5;

// Dependencies are linked from the source checkout for ordinary ephemeral
// worktrees. Dependency-update tasks opt out so package managers cannot mutate
// the source checkout's installed tree through these links.
async function worktreeDependencyPaths(sourceWorkspace, worktreePath, { cleanup = false } = {}) {
  const entries = await readdir(worktreePath, { withFileTypes: true });
  const children = await Promise.all(entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(async ({ name }) => {
      // Cleanup must still find owned links after a package or its source is removed.
      if (cleanup) return join(name, 'node_modules');
      const sourceDirectory = await lstat(join(sourceWorkspace, name)).catch(() => null);
      if (!sourceDirectory?.isDirectory()) return null;
      if (existsSync(join(sourceWorkspace, name, '.git')) || existsSync(join(worktreePath, name, '.git'))) return null;
      const manifest = await lstat(join(worktreePath, name, 'package.json')).catch(() => null);
      if (!manifest?.isFile()) return null;
      return join(name, 'node_modules');
    }));
  return ['node_modules', ...children.filter(Boolean)];
}

/**
 * Make installed dependencies available to a fresh worktree without copying
 * or reinstalling them. Missing source directories are skipped so this also
 * works for managed repositories that do not use PortOS's client/server
 * layout. Existing paths are preserved, including real directories and links.
 * A root node_modules holding workspace links is rebuilt as a real directory
 * so those links resolve inside the worktree, not the source (#12633).
 */
export async function linkWorktreeDependencies(sourceWorkspace, worktreePath) {
  const dependencyPaths = await worktreeDependencyPaths(sourceWorkspace, worktreePath);
  await Promise.all(dependencyPaths.map(async (relativePath) => {
    const sourcePath = join(sourceWorkspace, relativePath);
    const targetPath = join(worktreePath, relativePath);
    const sourceExists = await stat(sourcePath).then(info => info.isDirectory()).catch(() => false);
    if (!sourceExists) return;
    const targetStat = await lstat(targetPath).catch(() => null);
    if (targetStat) {
      const isSymlink = targetStat.isSymbolicLink?.() ?? false;
      const isDir = targetStat.isDirectory?.() ?? !isSymlink;
      if (!isSymlink && isDir) {
        const entries = await readdir(targetPath).catch(() => null);
        if (entries !== null && entries.length > 0 && entries.every(name => CACHE_ENTRIES.has(name))) {
          await rm(targetPath, { recursive: true, force: true });
        } else {
          console.warn(`⚠️ linkWorktreeDependencies: skipping existing ${targetPath} (not a cache-only directory)`);
          return;
        }
      } else {
        return;
      }
    }
    if (relativePath === 'node_modules' && await provisionWorkspaceNodeModules(sourceWorkspace, worktreePath)) return;
    await symlink(sourcePath, targetPath, 'dir');
  }));
}

/**
 * Remove only dependency symlinks that point back into the source checkout,
 * plus a root node_modules this module provisioned as a link farm. Real
 * dependency directories and links managed by another tool stay intact.
 */
export async function unlinkWorktreeDependencies(sourceWorkspace, worktreePath) {
  const dependencyPaths = await worktreeDependencyPaths(sourceWorkspace, worktreePath, { cleanup: true });
  await Promise.all(dependencyPaths.map(async (relativePath) => {
    const sourcePath = join(sourceWorkspace, relativePath);
    const targetPath = join(worktreePath, relativePath);
    const targetStat = await lstat(targetPath).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!targetStat) return;
    if (!targetStat.isSymbolicLink()) {
      if (relativePath === 'node_modules') await removeProvisionedNodeModules(sourceWorkspace, worktreePath);
      return;
    }

    const linkTarget = await readlink(targetPath);
    const linkedPath = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(targetPath), linkTarget);
    if (pathsEqual(linkedPath, sourcePath)) await unlink(targetPath);
  }));
}

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
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(repo, () => addWorktreeAdmitted(args, repo, attempt, firstError));
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

// Per-source-repo serialization tail for worktree-creating git operations —
// the createKeyCachedQueue pattern (see server/services/pipeline/issuesShared.js). Git
// serializes its own worktree bookkeeping behind a per-repo lock, so two
// `git worktree add` calls in the same evaluation tick race and the loser is
// blocked with `blockedCategory: worktree-failed` (#2193). A single promise
// tail per repo collapses that race: each create awaits the previous one to
// settle before touching the shared `.git/worktrees` state. Keyed by
// realpath-resolved repo path so /var vs /private/var (macOS) don't split the
// tail into two lanes that can still collide.
const queueWorktreeCreateForKey = createKeyCachedQueue();
async function queueWorktreeCreate(repo, fn) {
  // Linked checkouts share branch refs even when their working paths differ.
  // Resolve that common identity before entering the mutation lane.
  const common = await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo)
    .then(result => result.stdout.trim()).catch(() => null);
  let key = common && isAbsolute(common) ? common : repo;
  try { key = realpathSync(key); } catch { /* invalid repositories fail in the operation itself */ }
  if (!key) key = '__unknown__';
  return queueWorktreeCreateForKey(key, async () => {
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    return withCheckoutPublication(repo, () => fn(common));
  });
}

/** Delete one completed local ref through Git's receiver. Unlike update-ref,
 * receive-pack checks all registered worktree holders; unlike branch -D, its
 * transaction also compares the old object id. The local absolute destination
 * cannot resolve through an origin push URL. Existing hooks and denyDeletes
 * policy still apply. Share the creation lane so managed attachments cannot
 * enter between the receiver's holder check and ref transaction. After the ref
 * is gone, the local branch section is removed so a reused name does not
 * inherit retired settings. Nothing is copied under branch-retirement-archives.
 * `onRetired` runs only after that deletion.
 */
export function deleteCompletedLocalBranch(repoPath, branch, expectedHead, { beforeMutation = async () => {}, onRetired = async () => {} } = {}) {
  let callbackError;
  return queueWorktreeCreate(repoPath, async (commonDir) => {
    if (PROTECTED_BRANCHES.includes(branch)) return false;
    const { getDefaultBranch } = await import('./git.js');
    const defaultBranch = await getDefaultBranch(repoPath, { strict: true }).catch(() => null);
    if (!defaultBranch || branch === defaultBranch) return false;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead || '')) return false;
    const ref = `refs/heads/${branch}`;
    if ((await execGit(['check-ref-format', ref], repoPath, { ignoreExitCode: true })).exitCode !== 0) return false;
    const common = (commonDir && isAbsolute(commonDir)) ? commonDir
      : (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath)).stdout.trim();
    if (!isAbsolute(common)) return false;
    const head = (await execGit(['rev-parse', '--verify', ref], repoPath).catch(() => null))?.stdout?.trim();
    if (head !== expectedHead) return false;
    await Promise.resolve().then(beforeMutation).catch(error => { callbackError = error; throw error; });
    const result = await execGit(['push',
      '--receive-pack=git -c receive.denyCurrentBranch=refuse -c receive.denyDeleteCurrent=refuse -c receive.autogc=false receive-pack',
      `--force-with-lease=${ref}:${expectedHead}`, '--', common, `:${ref}`], repoPath, { ignoreExitCode: true });
    if (result.exitCode !== 0) return false;
    const absent = await execGit(['show-ref', '--verify', '--quiet', ref], repoPath, { ignoreExitCode: true });
    if (absent.exitCode !== 1) return false;
    await execGit(['config', '--local', '--remove-section', `branch.${branch}`], repoPath, { ignoreExitCode: true }).catch(() => {});
    await Promise.resolve().then(() => onRetired({ branchDeleted: true })).catch(error => { callbackError = error; throw error; });
    return true;
  }).catch(error => { if (error === callbackError) throw error; return false; });
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

/**
 * Delete a branch a failed `git worktree add -b/-B` left orphaned (a ref with
 * no worktree), so failed adds don't accumulate orphan branches (#2193).
 * Best-effort: every step swallows its own error. Only call for NEW-branch
 * adds — never for attach-to-existing-branch, which would delete a branch we
 * didn't create.
 *
 * Takes the causing error so it can:
 *   - SKIP entirely when the add failed because the branch already existed
 *     (`isPreexistingRefError`) — that branch pre-dated us and may hold real
 *     commits; deleting it would be data loss. This keys off the FIRST
 *     attempt's error (`err.firstAttemptError`), not the final one: a retried
 *     `-b` add that created the branch on attempt 1 then failed with a
 *     retry-induced `branch already exists` on attempt 2 must still clean up
 *     the orphan branch it created (#2193).
 *   - PRUNE before deleting: a partial add can register a stale worktree AND
 *     create the branch, so a bare `git branch -D` fails with "used by
 *     worktree". `worktree prune` first clears that registration so the delete
 *     succeeds.
 */
async function cleanupOrphanBranch(repo, branchName, err) {
  if (!branchName) return;
  // The original failure cause decides whether the branch pre-dated us — a
  // later attempt's `already exists` can be self-inflicted by attempt 1.
  const causeError = err?.firstAttemptError || err;
  if (isPreexistingRefError(causeError?.message)) return;
  await execGit(['worktree', 'prune'], repo).catch(() => {});
  await execGit(['branch', '-D', branchName], repo).catch(pruneErr => {
    console.log(`⚠️ Orphan branch cleanup failed for ${branchName}: ${pruneErr.message}`);
  });
}

/** Longest error excerpt a removal warning carries — warnings reach cards and task context. */
const REMOVAL_ERROR_EXCERPT_CHARS = 200;

/** First line of an error, bounded, for a one-line warning. */
function errorExcerpt(err) {
  return String(err?.message ?? err ?? '').split('\n')[0].slice(0, REMOVAL_ERROR_EXCERPT_CHARS);
}

/**
 * Realpath of `p` even when `p` itself is gone: resolve the deepest existing
 * ancestor and re-append the missing tail, so a removed worktree compares equal
 * to the form git registered it under (macOS /var → /private/var).
 */
function canonicalPath(p) {
  try { return realpathSync.native(p); } catch { /* fall through to the ancestor walk */ }
  const parent = dirname(p);
  return parent === p ? p : join(canonicalPath(parent), p.slice(parent.length).replace(/^[\\/]+/, ''));
}

/**
 * Observe whether a worktree's directory and Git registration are really gone.
 * Each probe answers `'unknown'` when it could not be read — an unverifiable
 * state is NOT absence, so callers never report cleanup they did not establish.
 *
 * @returns {Promise<{directory: 'present'|'absent'|'unknown', registration: 'registered'|'absent'|'unknown'}>}
 */
async function probeWorktreeRemoval(repo, worktreePath) {
  const directory = await lstat(worktreePath).then(
    () => 'present',
    (err) => (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'absent' : 'unknown'),
  );
  const target = canonicalPath(worktreePath);
  let entries = null;
  const registration = await listWorktrees(repo).then(
    (list) => {
      entries = list;
      return list.some(wt => canonicalPath(wt.path) === target) ? 'registered' : 'absent';
    },
    () => 'unknown',
  );
  return { directory, registration, entries };
}

/**
 * Fold a probe into the removal outcome every caller consumes. `removed` is true
 * only when BOTH the directory and the registration were observed absent;
 * `warning` is a bounded, retryable one-liner when they were not.
 */
function removalOutcome(worktreePath, { directory, registration }, failure = null) {
  const removed = directory === 'absent' && registration === 'absent';
  const state = `directory ${directory === 'absent' ? 'removed' : directory === 'present' ? 'still present' : 'unverified'}, `
    + `git registration ${registration === 'absent' ? 'removed' : registration === 'registered' ? 'still registered' : 'unverified'}`;
  return {
    removed,
    directory,
    registration,
    warning: removed ? null : `Worktree cleanup incomplete for ${worktreePath} (${state})${failure ? `: ${failure}` : ''} — retryable`,
  };
}

/**
 * Remove a worktree directory robustly: try `git worktree remove --force`, and
 * if git refuses, preserve surviving contents and only prune an absent tree.
 * Git's lock-aware remove is the only operation allowed to delete a checkout.
 * Never throws — cleanup is best-effort and must never throw into a
 * completion/reap path — but it DOES report what it achieved: after every
 * attempt it re-reads the exact directory and its Git registration, and
 * `removed` is true only when both are observed gone. A caller that releases a
 * branch, counts a reap or queues a follow-up must gate on `removed`; swallowing
 * the failure is how a checkout that survived read as a completed cleanup.
 * Shared by removeWorktree, removePersistentWorktree, reapMergedWorktrees,
 * branch reconciliation and the worktree-add rollback.
 *
 * @param {string} repo - the git workspace to run worktree commands in (the
 *   parent repo for the worktree, NOT the worktree dir itself).
 * @param {string} worktreePath - absolute path of the worktree dir to remove.
 * @param {object} [opts]
 * @param {string} [opts.label] - traceability tag for the fallback log line
 *   (`⚠️ <label>: <err>`). Required for any logging; omit for a fully silent
 *   cleanup (background paths that must not spam on the common case).
 * @param {'remove'|'all'} [opts.log='remove'] - how much to log when `label` is
 *   set: `'remove'` logs only the `worktree remove` failure (the operator-
 *   facing signal); `'all'` also logs a prune failure. Ignored when
 *   `label` is absent (nothing logs). The two flags the four callers needed —
 *   "label + log everything" and "label + log remove only" and "silent" — are
 *   the three states here; there was never a "log without a label" caller.
 * @param {string} [opts.subject] - identifier embedded in prune
 *   failure messages (only used when `log:'all'`). Defaults to
 *   `worktreePath`; the agent-cleanup callers pass their agent id so the
 *   message wording stays byte-identical to the pre-extraction logs an operator
 *   may grep for (e.g. `… for worktree <agentId>`).
 * @param {(holder: object|null) => Promise<string|null>} [opts.verifyRemoval] -
 *   caller's fresh ownership/content gate, run before Git removal and rechecked
 *   after a refusal to report the current hold.
 *   Callers that share claim ownership hold its lock through this operation.
 * Local content is not a hold here: callers retire only merged deliveries,
 * throwaway checkouts or a rolled-back add, whose ignored and uncommitted
 * bytes are disposable.
 * @returns {Promise<{removed: boolean, directory: string, registration: string, warning: string|null}>}
 *   `warning` is set exactly when `removed` is false.
 */
export async function forceRemoveWorktreeDir(repo, worktreePath, opts = {}) {
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(repo, () => forceRemoveWorktreeDirAdmitted(repo, worktreePath, opts))
    .catch(error => ({ removed: false, reason: error.message, warning: 'Checkout retained: repository reservation unavailable' }));
}

// Hold reasons that mean the cleanup could not even decide, rather than a gate declining.
const REMOVAL_FAULT_HOLDS = new Set(['worktree-ownership-unreadable', 'worktree-removal-refused']);

async function forceRemoveWorktreeDirAdmitted(repo, worktreePath, { label, log = 'remove', subject = worktreePath, verifyRemoval, beforeMutation } = {}) {
  const logAll = label && log === 'all';
  let lastFailure = null;
  let heldReason = null;
  const check = async () => {
    const entries = await listWorktrees(repo).catch(() => null);
    if (!entries) return 'worktree-ownership-unreadable';
    const holder = entries.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath)) || null;
    if (holder?.locked) return 'worktree-locked';
    const reason = verifyRemoval ? await verifyRemoval(holder, entries).catch(() => 'worktree-ownership-unreadable') : null;
    if (reason) return reason;
    // Ownership checks await I/O. Refresh their registration afterward;
    // Git's own removal still honors locks acquired after this final read.
    const fresh = await listWorktrees(repo).catch(() => null);
    if (!fresh) return 'worktree-ownership-unreadable';
    const current = fresh.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath)) || null;
    if (current?.locked) return 'worktree-locked';
    if (current?.branch !== holder?.branch || current?.head !== holder?.head) return 'worktree-holder-changed';
    return null;
  };
  heldReason = await check();
  if (!heldReason) await beforeMutation?.();
  if (!heldReason) await execGit(['worktree', 'remove', worktreePath, '--force'], repo, { timeout: WORKTREE_ADD_TIMEOUT_MS }).catch(async (err) => {
    lastFailure = errorExcerpt(err);
    if (label) console.log(`⚠️ ${label}: ${err.message}`);
    heldReason = await check();
    if (heldReason) return;
    // A refusal is not authority to erase a surviving checkout. A raw rm could
    // bypass a lock acquired after our last read, even with a caller guard.
    const directory = await lstat(worktreePath).then(() => 'present', err => err.code === 'ENOENT' ? 'absent' : 'unknown');
    if (directory !== 'absent') { heldReason = 'worktree-removal-refused'; return; }
    await beforeMutation?.();
    await execGit(['worktree', 'prune'], repo).catch((pruneErr) => {
      lastFailure = errorExcerpt(pruneErr);
      if (logAll) console.log(`⚠️ Worktree prune failed for ${subject}: ${pruneErr.message}`);
    });
  });
  const probe = await probeWorktreeRemoval(repo, worktreePath);
  const outcome = removalOutcome(worktreePath, probe, heldReason || lastFailure);
  if (probe.entries) outcome.entries = probe.entries;
  if (heldReason) outcome.reason = heldReason;
  if (!outcome.removed && label) {
    // A gate keeping the checkout is the cleanup working as designed (the warning
    // says "retryable"); an unreadable registry or a removal Git refused is a fault.
    const designedHold = heldReason && !REMOVAL_FAULT_HOLDS.has(heldReason);
    if (designedHold) console.log(`⏸️ ${outcome.warning}`);
    else console.warn(`⚠️ ${outcome.warning}`);
  }
  return outcome;
}

/**
 * Run the upstream guard on a branch whose worktree ALREADY exists, undoing the
 * add if the guard refuses (#4172).
 *
 * `enforceSafeBranchUpstream` throws when a branch's upstream still aims at a
 * foreign ref after repair — correct, because every downstream push helper would
 * land there. But the throw happens AFTER `git worktree add` succeeded, so
 * without this the caller gets a failed create while a registered worktree (and,
 * for a fresh `-b` add, an orphan branch) stays on disk: exactly the debris
 * `cleanupOrphanBranch` already prevents on the add itself.
 *
 * `deleteBranch` is false on the attach paths — that branch pre-dates this add
 * and may hold real commits, the same distinction `cleanupOrphanBranch` makes.
 */
async function enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch, remoteBranch = branchName, forkRemote = null }) {
  const configure = async () => {
    if (forkRemote) {
      await execGit(['config', `branch.${branchName}.remote`, forkRemote], worktreePath);
      await execGit(['config', `branch.${branchName}.merge`, `refs/heads/${remoteBranch}`], worktreePath);
      await execGit(['config', `branch.${branchName}.pushRemote`, forkRemote], worktreePath);
    }
    return enforceSafeBranchUpstream(sourceWorkspace, branchName, { remoteBranch });
  };
  return configure().catch(async (err) => {
    const undone = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
      label: `Undoing worktree add for ${branchName} after an unsafe upstream`,
      log: 'all',
      subject: branchName,
    });
    // A branch still held by the surviving checkout cannot be deleted; leave it
    // rather than attempt a `branch -D` that fails. The ORIGINAL error is what
    // the caller sees either way — the rollback outcome never replaces it.
    if (deleteBranch && undone.removed) await cleanupOrphanBranch(sourceWorkspace, branchName, err);
    throw err;
  });
}

/**
 * Classify a `git status --porcelain` blob into real changes vs auto-generated
 * lockfile churn. Pure (testable) — callers decide what to do with the result.
 *
 * PortOS's own runtime scratch (`AGENT_SCRATCH_PATHS` — the public-review input
 * bundle and its patch directory) is subtracted for EVERY caller, not passed in
 * per call. It is written by PortOS into the worktree and never committed, so a
 * tree holding only that is finished work by every consumer's definition; making
 * each one learn the names is how two `pr-reviewer` worktrees survived
 * `removeWorktree`, `reapMergedWorktrees` and branch-reconcile in turn.
 *
 * @param {string} porcelain - raw `git status --porcelain` stdout
 * @param {object} [options]
 * @param {string[]} [options.ignoredPaths] - ADDITIONAL runtime-only paths that
 *   must not preserve a completed worktree — for names this module cannot know
 *   statically, notably one run's own `.agent-done-<agentId>` sentinel. Matched
 *   as roots: a directory entry also covers everything under it. They are still
 *   removed only when the rest of the tree is safe to remove.
 * @param {{ ignoredPaths?: string[], preserveLockfiles?: boolean }} [opts] - `preserveLockfiles` classifies lockfiles as real changes
 * @returns {{ clean: boolean, lockfileOnly: boolean, lockfilePaths: string[], untrackedLockfilePaths: string[], realChangePaths: string[], hasRealChanges: boolean }}
 *   - clean: no changes at all
 *   - lockfileOnly: every change is an auto-generated lockfile (safe to discard)
 *   - lockfilePaths: paths of those lockfiles (strip the porcelain `XY ` status prefix)
 *   - untrackedLockfilePaths: the subset of lockfilePaths that is untracked (`??`)
 *   - realChangePaths: paths of the NON-lockfile changes, same prefix stripping.
 *     Branch reconciliation intersects these with what the default branch has
 *     touched since the branch diverged, to spot work that may have been
 *     superseded while it sat uncommitted.
 *   - hasRealChanges: at least one non-lockfile change (worktree must be preserved)
 */
export function classifyWorktreeDirt(porcelain, { ignoredPaths = [], preserveLockfiles = false } = {}) {
  const ignored = [...AGENT_SCRATCH_PATHS, ...ignoredPaths];
  // Git's porcelain v1 output C-quotes paths with spaces and several other
  // characters. Decode those paths before comparing them with scratch roots or
  // lockfile names. Octal escapes represent bytes, so collect them as bytes and
  // decode UTF-8 only after the whole quoted path has been read.
  const unquoteGitPath = (path) => {
    if (!path.startsWith('"') || !path.endsWith('"')) return path;
    const bytes = [];
    for (let i = 1; i < path.length - 1; i += 1) {
      const char = path[i];
      if (char !== '\\') {
        const codePoint = String.fromCodePoint(path.codePointAt(i));
        bytes.push(...Buffer.from(codePoint));
        i += codePoint.length - 1;
        continue;
      }
      const escaped = path[++i];
      if (/[0-7]/.test(escaped || '')) {
        const octal = path.slice(i, i + 3);
        if (!/^[0-7]{3}$/.test(octal)) {
          bytes.push(...Buffer.from(`\\${escaped}`));
          continue;
        }
        bytes.push(parseInt(octal, 8));
        i += 2;
        continue;
      }
      const controls = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
      if (Object.hasOwn(controls, escaped)) bytes.push(controls[escaped]);
      else bytes.push(...Buffer.from(escaped || ''));
    }
    return Buffer.from(bytes).toString('utf8');
  };
  const splitRename = (path) => {
    let quoted = false;
    let escaped = false;
    for (let i = 0; i <= path.length - 4; i += 1) {
      const char = path[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && path.startsWith(' -> ', i)) return [path.slice(0, i), path.slice(i + 4)];
    }
    return [path];
  };
  const toPath = (line) => {
    const statusless = line.replace(/^\s*\S+\s+/, '');
    return splitRename(statusless).map(unquoteGitPath).at(-1);
  };
  const lines = (porcelain || '').split('\n')
    .filter(l => l.trim())
    .filter(line => !matchesScratchRoot(toPath(line), ignored));
  if (lines.length === 0) {
    return { clean: true, lockfileOnly: false, lockfilePaths: [], untrackedLockfilePaths: [], realChangePaths: [], hasRealChanges: false };
  }
  // `dependency-updates` can legitimately deliver a lockfile-only diff (`npm audit
  // fix`, a transitive bump), so there a lockfile is work, never churn.
  const isLockfile = (line) => !preserveLockfiles && AUTO_GENERATED_LOCKFILES.some(f => toPath(line).endsWith(f));
  // `R old -> new` (rename) names two paths; the post-rename path is the one
  // that exists on disk and the one a diff against the default branch reports.
  const lockfileLines = lines.filter(isLockfile);
  const lockfileOnly = lockfileLines.length === lines.length;
  return {
    clean: false,
    lockfileOnly,
    lockfilePaths: lockfileLines.map(toPath),
    // Untracked (`??`) lockfiles have no index entry, so `git checkout --` cannot
    // restore them; discardLockfileChanges deletes these instead.
    untrackedLockfilePaths: lockfileLines.filter(line => line.startsWith('??')).map(toPath),
    realChangePaths: lines.filter((line) => !isLockfile(line)).map(toPath),
    hasRealChanges: !lockfileOnly
  };
}

/**
 * Discard the auto-generated lockfile churn that `classifyWorktreeDirt` reported.
 * Untracked lockfiles are deleted (git cannot restore what it does not track);
 * tracked ones are restored from the index. Rejects if either step fails, so the
 * caller decides whether the tree is still safe to remove.
 */
async function discardLockfileChanges(worktreePath, dirt) {
  const untracked = new Set(dirt.untrackedLockfilePaths);
  for (const path of untracked) {
    await rm(join(worktreePath, path), { force: true });
  }
  const tracked = dirt.lockfilePaths.filter(path => !untracked.has(path));
  if (tracked.length) await execGit(['checkout', '--', ...tracked], worktreePath);
}

/** A proven-absent directory is empty; an existing tree must identify itself.
 * Git can otherwise walk out of a broken linked checkout and report its parent
 * clean. null means unknown, including unreadable directories or status errors.
 */
export async function readWorktreeStatus(worktreePath) {
  const present = await lstat(worktreePath).then(() => true,
    err => err.code === 'ENOENT' || err.code === 'ENOTDIR' ? false : null);
  if (present === false) return '';
  if (present === null) return null;
  const top = await execGit(['rev-parse', '--show-toplevel'], worktreePath).then(r => r.stdout.trim()).catch(() => null);
  if (!top || !pathsEqual(top, worktreePath)) return null;
  const status = await execGit(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], worktreePath,
    { ignoreExitCode: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).catch(() => null);
  return status?.exitCode === 0 ? status.stdout : null;
}

/**
 * Compare two filesystem paths for equality, resolving symlinks (e.g. macOS
 * /var → /private/var) and Windows short-name aliases. Native realpath resolves
 * the latter where the JavaScript implementation can retain the input spelling.
 */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const resolved = (p) => { try { return realpathSync.native(p); } catch { return p; } };
  return resolved(a) === resolved(b);
}

/**
 * Decide whether an auto-merge into `currentBranch` should be refused.
 *
 * Pure helper for the defense-in-depth gate in `removeWorktree`: an agent's
 * branch must NEVER be merged into a feature/claim branch — only into the
 * source repo's configured default (`main`, `master`, etc.). When the user
 * is mid-claim on `claim/foo`, a CoS task finishing its work must not
 * fast-forward `claim/foo` onto the agent's branch. The PR flow
 * (`gh pr merge`) is the only sanctioned integration path for non-default
 * targets.
 *
 * Returns `true` when the caller must skip the merge and preserve the
 * agent's branch for manual / PR-driven integration. Falsy default branch
 * means detection failed — refuse rather than guess, since the worst-case
 * cost of a refusal (preserved branch) is much smaller than the worst-case
 * cost of a wrong merge (clobbered user work).
 */
export function shouldRefuseDefaultBranchMerge(currentBranch, defaultBranch) {
  if (!currentBranch) return true;
  if (!defaultBranch) return true;
  return currentBranch !== defaultBranch;
}

/**
 * Point a deterministic remote at the fork that holds a cross-repository PR's
 * head branch, fetch that branch, and hand back the remote's name.
 *
 * A fork PR's branch has no `origin/<branch>` — the forge exposes its tip only
 * as the read-only `refs/pull/<n>/head`, which cannot be pushed back to — so a
 * worktree attach needs a second address for it. The coordinates arrive from a
 * caller that already read the PR (`normalizeForkHead`); this layer never calls
 * a forge, which is why it takes a URL rather than a PR number.
 *
 * The remote is named from the OWNER, not from the run, so a second review
 * round or a retried remediation reuses it instead of accumulating one remote
 * per attach — and so teardown can leave it alone, which is what makes that
 * reuse free. An existing remote pointing somewhere else is re-pointed rather
 * than treated as a conflict.
 *
 * Returns `null` for every unusable outcome (no coordinates, remote wouldn't
 * take, fetch failed, ref still missing afterwards) so the caller falls through
 * to its existing origin-only error instead of attaching to a ref it cannot
 * verify.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {unknown} forkHead - `{ remoteUrl, ownerLogin }` from the PR read
 * @param {string} branchName - the PR's head branch, as named in the fork
 * @param {{requireRef?: boolean}} options - existing local recovery needs only the remote configuration
 * @returns {Promise<string|null>} the fork remote's name, or null
 */
async function ensureForkRemote(sourceWorkspace, forkHead, branchName, { requireRef = true } = {}) {
  const remoteName = await pointForkRemote(sourceWorkspace, forkHead, branchName);
  if (!remoteName) return null;

  await execGit(['fetch', remoteName, branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Fork fetch of ${remoteName}/${branchName} failed: ${err.message}`);
  });
  // Verify rather than trust the fetch's exit code: a fetch that reported
  // success but left no remote-tracking ref would otherwise send `worktree add`
  // at a start point git resolves somewhere else entirely.
  const refExists = await execGit(['rev-parse', '--verify', `${remoteName}/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  return refExists || !requireRef ? remoteName : null;
}

/** Add or re-point the deterministic fork remote; its name, or null. */
async function pointForkRemote(sourceWorkspace, forkHead, branchName) {
  const coordinates = normalizeForkHead(forkHead);
  if (!coordinates) return null;
  const remoteName = forkRemoteName(coordinates.ownerLogin);
  if (!remoteName) return null;

  // Three outcomes, not two: `null` is "no such remote" (add it), an equal URL
  // is "already correct" (touch nothing), and a different URL is a stale remote
  // from a contributor who renamed or moved their fork (re-point it).
  const existingUrl = await execGit(['remote', 'get-url', remoteName], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? (r.stdout || '').trim() : null))
    .catch(() => null);
  const remoteOp = existingUrl === null
    ? ['remote', 'add', remoteName, coordinates.remoteUrl]
    : (existingUrl === coordinates.remoteUrl ? null : ['remote', 'set-url', remoteName, coordinates.remoteUrl]);
  if (remoteOp) {
    const pointed = await execGit(remoteOp, sourceWorkspace).then(() => true).catch(err => {
      console.log(`⚠️ Could not point ${remoteName} at the fork holding ${branchName}: ${err.message}`);
      return false;
    });
    if (!pointed) return null;
  }
  return remoteName;
}

/** `err.code` when a pinned attach finds the branch tip is not the reviewed commit. */
export const PINNED_HEAD_MOVED = 'PINNED_HEAD_MOVED';

function requirePinnedHeadSha(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Invalid pinned head commit');
  return sha;
}

function pinnedHeadMoved(branchName, pinnedHead, actual) {
  const err = new Error(`Cannot attach worktree to ${branchName}: the branch is ${actual ? `at ${actual}` : 'gone'}, not the reviewed head ${pinnedHead}`);
  err.code = PINNED_HEAD_MOVED;
  err.actualHeadSha = actual || null;
  return err;
}

/**
 * Attach `branchName` from `remote` at exactly `pinnedHead`, the commit that was
 * reviewed — the attached code is then executed, so nothing else may land.
 *
 * The tip comes from the remote itself (`ls-remote`), never a cached tracking
 * ref, and a branch the remote no longer has is a moved head too. The fetch
 * names its destination so the tracking ref cannot stay stale under a narrow
 * refspec. The checkout uses the SHA, so a ref update after the check cannot
 * swap code in; an existing local branch must already name that exact commit.
 * `detach` checks the commit out with no branch at all (see `holdsCheckedOutBranch`).
 */
async function attachPinnedHead(sourceWorkspace, worktreePath, branchName, remoteBranch, remote, pinnedHead, localExists, { detach = false } = {}) {
  const listed = await execGit(['ls-remote', '--exit-code', remote, `refs/heads/${remoteBranch}`], sourceWorkspace, { ignoreExitCode: true });
  // `--exit-code` answers 2 for "no such ref"; anything else non-zero is a
  // transport failure, which proves nothing about the branch.
  if (listed.exitCode === 2) throw pinnedHeadMoved(branchName, pinnedHead, null);
  if (listed.exitCode !== 0) throw new Error(`Cannot attach worktree to ${branchName}: could not read ${remote}: ${(listed.stderr || '').trim()}`);
  const remoteTip = (listed.stdout || '').trim().split(/\s+/)[0];
  if (remoteTip !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, remoteTip);

  const trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
  await execGit(['fetch', remote, `+refs/heads/${remoteBranch}:${trackingRef}`], sourceWorkspace);
  const fetched = (await execGit(['rev-parse', '--verify', `${trackingRef}^{commit}`], sourceWorkspace)).stdout.trim();
  if (fetched !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, fetched);

  if (detach) {
    await addWorktreeWithRetry(['worktree', 'add', '--detach', worktreePath, pinnedHead], sourceWorkspace);
  } else if (localExists) {
    const localHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)).stdout.trim();
    if (localHead !== pinnedHead) {
      throw new Error(`Cannot attach worktree to ${branchName}: the local branch differs from the reviewed head; preserving it without reset`);
    }
    await addWorktreeWithRetry(['worktree', 'add', worktreePath, branchName], sourceWorkspace);
  } else {
    await addWorktreeWithRetry(['worktree', 'add', '--no-track', '-b', branchName, worktreePath, pinnedHead], sourceWorkspace);
  }
  // A concurrent external ref write must not hand unreviewed code to the agent.
  const attached = (await execGit(['rev-parse', '--verify', 'HEAD'], worktreePath)).stdout.trim();
  if (attached !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, attached);
}

/**
 * Is `branch` one a second worktree must never attach to by name: the repository's
 * default branch, or whatever the primary checkout has checked out? Git refuses the
 * second case outright, and the first is the branch a review fix must never be
 * pushed to without its own pull request (a release PR's head IS the default branch).
 */
async function holdsCheckedOutBranch(sourceWorkspace, branch, baseBranch) {
  const { getDefaultBranch } = await import('./git.js');
  const defaultBranch = baseBranch || await getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null);
  if (branch === defaultBranch) return { held: true, isDefault: true };
  const current = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true }).catch(() => null))?.stdout?.trim();
  return { held: current === branch, isDefault: false };
}

/**
 * Detached worktree at the reviewed head of a branch the primary checkout owns.
 * The follow-up can read, test and gate that exact commit; with no branch checked
 * out there is nothing for `git push` to default to and nothing for another
 * worktree to collide with. Fork heads never come here: they attach under their
 * own `fork/<owner>/<branch>` name.
 */
async function attachDetachedHead(sourceWorkspace, worktreePath, branch, pinnedHead, fetchSucceeded) {
  if (pinnedHead) {
    await attachPinnedHead(sourceWorkspace, worktreePath, branch, branch, 'origin', pinnedHead, false, { detach: true });
    return pinnedHead;
  }
  const head = await execGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '');
  if (!head) throw new Error(`Cannot attach worktree to ${branch}: origin/${branch} unavailable${fetchSucceeded ? '' : ' (fetch failed)'}`);
  await addWorktreeWithRetry(['worktree', 'add', '--detach', worktreePath, head], sourceWorkspace);
  return head;
}

/**
 * Create a git worktree for an agent.
 *
 * Creates a new branch and worktree directory that the agent can work in
 * without disturbing the main workspace.
 *
 * For managed apps, the worktree is based on the latest remote default branch
 * (main/master) to ensure a clean starting point free from other agents' changes.
 *
 * When `options.existingBranch` is provided, the worktree tracks that pre-existing
 * branch instead of creating a new one — used for the Copilot review-loop follow-up
 * agent that needs to address comments on a PR branch the previous agent just pushed.
 *
 * Fork heads resolve only through their fork and use a namespaced local branch.
 * Same-repository heads retain local → origin resolution.
 *
 * @param {string} agentId - The agent identifier (used for branch/directory naming)
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} taskId - Task identifier (included in branch name for traceability)
 * @param {object} options - Optional configuration
 * @param {string} options.baseBranch - Branch to base the worktree on (auto-detected if omitted)
 * @param {string} options.baseCommit - Exact server-owned source commit for a fresh Deep resume
 * @param {string} options.existingBranch - Pre-existing branch to attach (creates from origin/<branch> if no local copy). When it is the default branch or the primary checkout's own branch the worktree is DETACHED at the branch's reviewed head instead (`detached: true` in the result).
 * @param {string} options.resumeBranch - Exact preserved local branch from a retry, including pre-namespace fork branches
 * @param {{remoteUrl: string, ownerLogin: string}} options.forkHead - Where `existingBranch` lives for a fork PR; checked out as fork/<owner>/<branch>.
 * @param {string} options.expectedHeadSha - Attach only at the reviewed remote tip; existing local work is never reset.
 * @param {string} options.planId - PLAN.md item slug ID — when provided, spliced into the branch name as `cos/<taskId>/<planId>/<agentId>` so other agents can detect this item is in flight by scanning branches/PRs
 * @param {boolean} options.linkDependencies - Link source dependencies unless explicitly false
 * @returns {{ worktreePath: string, branchName: string, baseBranch: string|null, existingBranch?: boolean }} paths for the new worktree
 */
export async function createWorktree(agentId, sourceWorkspace, taskId, options = {}) {
  // Serialize per source repo so two adds in the same evaluation tick can't
  // race on git's per-repo worktree lock (#2193). The whole body runs inside
  // the tail — not just the add — because the leading `git fetch origin` also
  // touches the shared ref store and two concurrent fetches on the same repo
  // can themselves hit `cannot lock ref` contention. Same-repo spawn prep is
  // low-frequency (a handful of tasks per tick), so serializing the fetch is a
  // cheap, safe trade for the race guarantee. See queueWorktreeCreate.
  return queueWorktreeCreate(sourceWorkspace, () => createWorktreeUnlocked(agentId, sourceWorkspace, taskId, options));
}

async function createWorktreeUnlocked(agentId, sourceWorkspace, taskId, options = {}) {
  if (!existsSync(WORKTREES_DIR)) {
    await ensureDir(WORKTREES_DIR);
  }

  const worktreePath = join(WORKTREES_DIR, agentId);

  // Stamp the producing machine's federation identity onto the worktree
  // metadata (issue #1563, acceptance criterion 1). The branch is named
  // `cos/<taskId>/<agentId>`, so recording which instance created it lets a
  // federated node pair attribute every worktree/branch to its origin instance
  // once CoS history federates. `ensureInstanceId()` creates the identity on the
  // cold path so the worktree is never tagged `unknown`.
  const instanceId = await ensureInstanceId();

  // Fetch latest from origin so we base off up-to-date refs
  const fetchSucceeded = await execGit(['fetch', 'origin'], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Worktree fetch failed (will use local refs): ${err.message}`);
      return false;
    });

  // Existing-branch path: attach the worktree to a branch that already lives on
  // the remote (e.g. the PR branch from the previous agent in a review loop).
  if (options.existingBranch) {
    const remoteBranch = options.existingBranch;
    const pinnedHead = options.expectedHeadSha === undefined ? null : requirePinnedHeadSha(options.expectedHeadSha);
    const forkHead = normalizeForkHead(options.forkHead);
    if (options.forkHead && !forkHead) throw new Error('Invalid fork head coordinates');
    const checkedOut = forkHead || options.resumeBranch
      ? { held: false, isDefault: false }
      : await holdsCheckedOutBranch(sourceWorkspace, remoteBranch, options.baseBranch);
    if (checkedOut.held) {
      const headSha = await attachDetachedHead(sourceWorkspace, worktreePath, remoteBranch, pinnedHead, fetchSucceeded);
      if (options.linkDependencies === false) {
        await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
      } else {
        await linkWorktreeDependencies(sourceWorkspace, worktreePath);
      }
      console.log(`🌳 Created detached worktree for ${agentId} at ${worktreePath} on ${remoteBranch}@${headSha.slice(0, 12)} (primary checkout holds the branch)`);
      return {
        worktreePath, branchName: remoteBranch, baseBranch: null, existingBranch: true, instanceId,
        detached: true, headSha, headIsDefaultBranch: checkedOut.isDefault,
      };
    }
    const branchName = options.resumeBranch || forkLocalBranch(remoteBranch, forkHead);
    const localExists = (await execGit(['branch', '--list', branchName], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
    if (options.resumeBranch && !localExists) throw new Error(`Cannot resume missing local branch ${branchName}`);
    // A pin must be verified against the fork itself, never origin's same-named branch.
    const forkRemote = forkHead ? await (pinnedHead ? pointForkRemote(sourceWorkspace, forkHead, remoteBranch)
      : ensureForkRemote(sourceWorkspace, forkHead, remoteBranch, { requireRef: !localExists })) : null;
    if (forkHead && !forkRemote) throw new Error(`Cannot attach worktree to fork branch ${remoteBranch}: fork ref unavailable`);
    if (pinnedHead) {
      await attachPinnedHead(sourceWorkspace, worktreePath, branchName, remoteBranch, forkRemote || 'origin', pinnedHead, !!localExists);
    } else if (localExists) {
      // Preserve unpublished local work. Never reset an existing checkout branch.
      await addWorktreeWithRetry(['worktree', 'add', worktreePath, branchName], sourceWorkspace);
    } else {
      const startPoint = forkRemote ? `${forkRemote}/${remoteBranch}` : `origin/${remoteBranch}`;
      const remoteExists = forkRemote || await execGit(['rev-parse', '--verify', startPoint], sourceWorkspace, { ignoreExitCode: true })
        .then(r => r.exitCode === 0).catch(() => false);
      if (!remoteExists) throw new Error(`Cannot attach worktree to ${branchName}: branch missing locally and origin/${branchName} unavailable${fetchSucceeded ? '' : ' (fetch failed)'}`);
      await addWorktreeWithRetry(['worktree', 'add', ...(forkRemote ? ['--no-track', '-b'] : ['-B']), branchName, worktreePath, startPoint], sourceWorkspace);
    }
    await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, {
      deleteBranch: false, remoteBranch, forkRemote: forkRemote || (pinnedHead ? 'origin' : null),
    });
    if (options.linkDependencies === false) {
      await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
    } else {
      await linkWorktreeDependencies(sourceWorkspace, worktreePath);
    }
    console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} on existing branch ${branchName}`);
    return { worktreePath, branchName, baseBranch: null, existingBranch: true, instanceId };
  }

  const branchName = options.planId
    ? `cos/${taskId}/${options.planId}/${agentId}`
    : `cos/${taskId}/${agentId}`;

  // Determine the base: explicit option > remote default branch > current HEAD
  let baseBranch = options.baseBranch;
  if (!baseBranch) {
    const { getDefaultBranch } = await import('./git.js');
    baseBranch = await getDefaultBranch(sourceWorkspace, { allowRemote: fetchSucceeded }).catch(() => null);
    if (!baseBranch) {
      baseBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace)).stdout.trim();
    }
  }

  // Prefer the remote ref (freshest state) if available
  let baseRef;
  if (options.baseCommit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.baseCommit)) throw new Error('Invalid pinned source commit');
    // Missing pins fail closed; falling back to moving main would erase coverage.
    baseRef = (await execGit(['rev-parse', '--verify', `${options.baseCommit}^{commit}`], sourceWorkspace)).stdout.trim();
  } else {
    baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
      .then(() => `origin/${baseBranch}`)
      .catch(() => baseBranch);
  }

  // Create worktree with a new branch based on the latest default branch.
  // `--no-track` is load-bearing, not tidiness (#4172): `baseRef` is normally the
  // remote-tracking `origin/<default>`, and git's default `branch.autoSetupMerge`
  // would record `branch.<name>.merge = refs/heads/main` on the new branch. Push
  // helpers derive their destination from that config — `/do:pr` pushes
  // `HEAD:$(git config branch.<name>.merge)` — so the agent's work lands straight
  // on main, skipping the PR. Untracked is what makes `git push -u origin <branch>`
  // the correct path. See lib/branchUpstreamGuard.js.
  // On final failure, delete the partially-created branch so a failed add
  // doesn't leave an orphan branch with no worktree (#2193).
  await addWorktreeWithRetry(
    ['worktree', 'add', '--no-track', '-b', branchName, worktreePath, baseRef],
    sourceWorkspace
  ).catch(async (err) => {
    await cleanupOrphanBranch(sourceWorkspace, branchName, err);
    throw err;
  });

  // Backstop the flag above — an older git, or a repo-level `branch.autoSetupMerge`
  // setting, must not be able to hand an agent a branch aimed at the default branch.
  await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch: true });
  if (options.linkDependencies === false) {
    await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
  } else {
    await linkWorktreeDependencies(sourceWorkspace, worktreePath);
  }

  console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} (branch: ${branchName}, base: ${baseRef})`);

  return { worktreePath, branchName, baseBranch, instanceId };
}

/**
 * Locate the worktree that currently holds `branchName`, when it is one PortOS
 * may take over — i.e. a tree `adoptWorktree` could legitimately move.
 *
 * `git worktree add` refuses to attach a second tree to a checked-out branch, so
 * a task pointed at an existing branch (a review-loop/merge follow-up, a resume)
 * cannot start while another tree holds it. Usually that holder is the finished
 * run's own worktree, still there because `removeWorktree` won't delete a dirty
 * tree — and it IS that branch's workspace, so adopting it is both the fastest
 * path and the one that preserves the leftover work. Waiting for a teardown that
 * is never coming just strands the pull request the follow-up exists to land.
 *
 * Refuses (returns null) for every holder PortOS doesn't own outright, because
 * adoption MOVES the directory:
 *   - the primary checkout, or any tree outside `data/cos/worktrees/` — moving
 *     the user's own checkout out from under them is exactly the branch-jacking
 *     guarded against everywhere else;
 *   - a human `/claim` tree (`claim-*`), owned by the claim flow's cleanup —
 *     unless the caller passes `allowLiveClaim` (see below);
 *   - a tree whose agent is still running — it is mid-edit in that directory;
 *   - a locked worktree, whose lock means "don't touch" regardless of owner.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} branchName - branch to find a holder for (no `refs/heads/`)
 * @param {object} [options]
 * @param {Set<string>} [options.activeAgentIds] - agents currently running
 * @param {string} [options.preferredPath] - cached holder path to validate first
 * @param {boolean} [options.allowLiveClaim=false] - recover a claim holder only
 *   after the supplied full registry passes branch/repository owner admission.
 * @param {Array<object>|null} [options.agents] - required for claim recovery
 * @param {string|null} [options.requestingAgentId] - the requesting run, not its predecessor
 * @returns {Promise<{ path: string, agentId: string }|null>}
 */
export async function findAdoptableWorktreeForBranch(sourceWorkspace, branchName, {
  activeAgentIds = new Set(),
  preferredPath = null,
  allowLiveClaim = false,
  agents = null,
  requestingAgentId = null,
} = {}) {
  if (!sourceWorkspace || !branchName) return null;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!worktrees) return null;
  if (allowLiveClaim && !claimBranchAdmission({
    branchName, preferredPath, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  // Git permits one holder per branch. A resume pointer is merely a cache of that
  // answer, so validate it against the current worktree list first and then fall
  // back to discovery when the cached path went stale or was moved.
  const holders = worktrees.filter(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  const holder = preferredPath
    ? holders.find(wt => pathsEqual(wt.path, preferredPath)) || holders[0]
    : holders[0];
  if (!holder?.path) return null;

  const agentId = worktreeAgentId(holder.path);
  const ownershipReason = worktreeOwnershipReason({
    path: holder.path,
    locked: holder.locked,
    activeAgentIds,
    roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
    requireKnownLiveness: true,
    allowLiveClaim,
  });
  if (ownershipReason) return null;

  return { path: holder.path, agentId };
}

// How long a sibling `/do:next` tree must sit untouched before a follow-up may
// release its branch. An agent that finished and kept its tree (waiting on CI,
// say) goes quiet for far longer; owner admission must pass independently.
export const SIBLING_NEXT_HOLDER_IDLE_MS = 10 * 60 * 1000;

/**
 * Free `branchName` from an idle slashdo `/do:next` worktree that sits OUTSIDE
 * `data/cos/worktrees/`, by DETACHING that tree's HEAD in place.
 *
 * `/do:next` cuts `next/<slug>` into a sibling directory of the repo
 * (`../next-issue-<n>`). A run that finished but kept its tree still holds the
 * branch, and the review-loop follow-up for that PR then cannot `worktree add`
 * it — adoption refuses any tree outside the managed root, so the follow-up
 * waits out its whole `worktree-busy` budget and blocks. Unlike adoption this
 * never moves or deletes the directory: a detached HEAD at the same commit keeps
 * every file, and `git switch <branch>` restores it.
 *
 * Refuses (returns false) unless ALL hold: the branch is `next/…`; the holder is
 * a linked worktree (never the primary checkout) outside the managed root,
 * unlocked; the readable registry has no branch/repository owner or running/paused
 * agent inside it; nothing in it changed for `idleMs`; the tree is clean, untracked files included
 * (unless `allowUntracked`: a detach leaves untracked files exactly where they are, so a
 * coordinator follow-up may take over a tree whose only dirt is stray untracked files such as
 * Finder "name 2.js" duplicates — tracked or staged changes still refuse); and HEAD is already on
 * the remote, so nothing is left only in that tree.
 *
 * @param {string} sourceWorkspace
 * @param {string} branchName
 * @param {{ activeWorkspacePaths?: string[], agents?: object[], requestingAgentId?: string, idleMs?: number, nowMs?: number, allowUntracked?: boolean }} [options]
 * @returns {Promise<{ path: string }|null>} the released holder, or null
 */
export async function releaseIdleSiblingNextHolder(sourceWorkspace, branchName, options = {}) {
  if (!sourceWorkspace || !branchName?.startsWith('next/')) return null;
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(sourceWorkspace, () => releaseIdleSiblingNextHolderAdmitted(sourceWorkspace, branchName, options));
}

async function releaseIdleSiblingNextHolderAdmitted(sourceWorkspace, branchName, {
  activeWorkspacePaths = [],
  agents = null,
  requestingAgentId = null,
  idleMs = SIBLING_NEXT_HOLDER_IDLE_MS,
  nowMs = Date.now(),
  allowUntracked = false,
} = {}) {
  if (!sourceWorkspace || !branchName?.startsWith('next/')) return null;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!claimBranchAdmission({
    branchName, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  const holderIndex = worktrees.findIndex(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  // Index 0 is the main worktree — the user's own checkout is never released.
  if (holderIndex <= 0) return null;
  const holder = worktrees[holderIndex];
  if (holder.locked || holder.prunable || !existsSync(holder.path)) return null;
  if (isPathInsideDir(WORKTREES_DIR, holder.path)) return null;
  if (activeWorkspacePaths.some(p => p && (pathsEqual(p, holder.path) || isPathInsideDir(holder.path, p)))) return null;

  const git = (args) => execGit(args, holder.path).then(r => r.stdout.trim());
  // Idleness first; `--no-optional-locks` keeps `status` from refreshing the
  // index and so resetting the very clock this reads on a refused attempt.
  const gitDir = await git(['rev-parse', '--absolute-git-dir']).catch(() => null);
  if (!gitDir) return null;
  const mtimes = await Promise.all(['index', 'HEAD', join('logs', 'HEAD')]
    .map(f => stat(join(gitDir, f)).then(s => s.mtimeMs, () => 0)));
  if (nowMs - Math.max(...mtimes) < idleMs) return null;

  if (!await detachCleanPushedHolder(holder.path, branchName, { allowUntracked })) return null;
  console.log(`🌳 Released ${branchName} from idle /do:next worktree ${holder.path} (HEAD detached in place)`);
  return { path: holder.path };
}

/**
 * Detach `holderPath`'s HEAD in place iff the tree holds nothing the branch ref
 * does not: tracked/staged state clean (untracked files too unless
 * `allowUntracked`; git-ignored caches never count) and HEAD already on the
 * remote. A detached HEAD keeps every file where it is and `git switch <branch>`
 * restores it. Any unreadable check refuses (false).
 */
async function detachCleanPushedHolder(holderPath, branchName, { allowUntracked = false } = {}) {
  const git = (args) => execGit(args, holderPath).then(r => r.stdout.trim());
  // Stricter than `classifyWorktreeDirt` on purpose: this tree isn't PortOS's,
  // so no path counts as disposable scratch.
  const porcelain = await git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']).catch(() => null);
  if (porcelain === null) return false;
  if (allowUntracked ? porcelain.split('\n').some(l => l && !l.startsWith('?? ')) : porcelain !== '') return false;
  const remoteRef = await git(['rev-parse', '--verify', '--quiet', `${branchName}@{upstream}`])
    .catch(() => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`]))
    .catch(() => null);
  if (!remoteRef) return false;
  const pushed = await execGit(['merge-base', '--is-ancestor', 'HEAD', remoteRef], holderPath)
    .then(() => true, () => false);
  if (!pushed) return false;

  const detached = await execGit(['switch', '--detach', '--quiet'], holderPath).then(() => true, (err) => {
    console.warn(`⚠️ Could not detach ${holderPath} to release ${branchName}: ${err.message}`);
    return false;
  });
  return detached;
}

/**
 * Free `branchName` from a worktree PortOS did not create and nothing owns
 * anymore — typically one a terminal agent session cut under its own scratchpad
 * and left behind after pushing its PR (#12845). Detaches the holder in place
 * (never moves or deletes it), so no content can be lost; the caller then
 * retries `git worktree add`.
 *
 * Refuses (null) unless ALL hold, each failing closed when unreadable: the
 * holder is a linked worktree (never the primary checkout) OUTSIDE the managed
 * `data/cos/worktrees/` root, unlocked, with no branch/repository owner or
 * running/paused agent registered in or on it; no process has its cwd inside it
 * (`hasProcessInside`); it is clean (git-ignored caches excepted) and its HEAD
 * is already on the remote.
 *
 * @param {string} sourceWorkspace
 * @param {string} branchName
 * @param {{ activeWorkspacePaths?: string[], agents?: object[]|null, requestingAgentId?: string, hasProcessInside?: (dir: string) => Promise<boolean> }} [options]
 * @returns {Promise<{ path: string }|null>} the released holder, or null
 */
export async function releaseOwnerlessForeignHolder(sourceWorkspace, branchName, options = {}) {
  if (!sourceWorkspace || !branchName || PROTECTED_BRANCHES.includes(branchName)) return null;
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(sourceWorkspace, () => releaseOwnerlessForeignHolderAdmitted(sourceWorkspace, branchName, options));
}

async function releaseOwnerlessForeignHolderAdmitted(sourceWorkspace, branchName, {
  activeWorkspacePaths = [],
  agents = null,
  requestingAgentId = null,
  hasProcessInside = hasProcessCwdInside,
} = {}) {
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!claimBranchAdmission({
    branchName, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  const holderIndex = worktrees.findIndex(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  // Index 0 is the main worktree — the user's own checkout is never released.
  if (holderIndex <= 0) return null;
  const holder = worktrees[holderIndex];
  if (holder.locked || holder.prunable || !existsSync(holder.path)) return null;
  // Managed trees have their own owners and reapers (adoption, claim cleanup).
  if (isPathInsideDir(WORKTREES_DIR, holder.path)) return null;
  if (activeWorkspacePaths.some(p => p && (pathsEqual(p, holder.path) || isPathInsideDir(holder.path, p)))) return null;
  if (await hasProcessInside(holder.path).catch(() => true)) return null;
  if (!await detachCleanPushedHolder(holder.path, branchName)) return null;
  console.log(`🌳 Released ${branchName} from ownerless foreign worktree ${holder.path} (HEAD detached in place)`);
  return { path: holder.path };
}

/**
 * Adopt an INTERRUPTED agent's surviving worktree on behalf of the agent that is
 * retrying its task, instead of building a fresh one from the default branch.
 *
 * When an agent dies without completing (a server restart is the common case —
 * PM2 kills the PTY, so no completion hook ever runs), `removeWorktree` refuses to
 * delete a dirty tree and leaves the whole worktree in place. That tree holds the
 * dead run's uncommitted edits and untracked files, which no branch pointer can
 * carry: without adoption the retry starts from origin/main and redoes the work.
 *
 * The tree is MOVED to the retry's own `<worktrees>/<agentId>` directory rather
 * than adopted where it sits, because "directory name == the agent that owns this
 * tree" is the invariant `cleanupOrphanedWorktrees` reaps on — left at the dead
 * agent's path, the live retry's worktree would be reaped out from under it. The
 * move carries tracked edits, untracked files, and git's own bookkeeping intact.
 *
 * Returns null (never throws) whenever adoption isn't possible — the source tree
 * is gone, the target path is occupied, or git refuses the move (a locked worktree,
 * or one with initialized submodules), or its status suggests a partial removal.
 * The refused tree and branch stay intact for recovery: a fresh attachment to
 * that same branch will remain blocked while this checkout holds it.
 *
 * @param {string} agentId - the RETRYING agent (names the destination directory)
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} existingWorktreePath - absolute path of the dead agent's worktree
 * @param {string} branchName - the branch that worktree has checked out
 * @returns {Promise<{worktreePath: string, branchName: string, baseBranch: null, existingBranch: true, adopted: true, instanceId: string}|null>}
 */
export async function adoptWorktree(agentId, sourceWorkspace, existingWorktreePath, branchName, options = {}) {
  return queueWorktreeCreate(sourceWorkspace, () => adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName, options));
}

async function adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName, options) {
  if (!agentId || !sourceWorkspace || !existingWorktreePath || !branchName) return null;
  if (!existsSync(existingWorktreePath)) {
    console.log(`🌳 Cannot adopt worktree for ${agentId} — ${existingWorktreePath} no longer exists`);
    return null;
  }

  const targetPath = join(WORKTREES_DIR, agentId);
  const instanceId = await ensureInstanceId();
  const adopted = {
    worktreePath: targetPath, branchName, baseBranch: null,
    existingBranch: true, adopted: true, instanceId
  };

  if (!pathsEqual(existingWorktreePath, targetPath) && existsSync(targetPath)) {
    console.log(`🌳 Cannot adopt worktree for ${agentId} — ${targetPath} is already occupied`);
    return null;
  }

  // A killed removal can leave thousands of unstaged deletions. The resume
  // prompt attributes all surviving changes to the agent, so do not hand it a
  // likely damaged checkout. Keep intentional small deletions and staged work;
  // this conservative threshold requires operator recovery for ambiguous bulk
  // deletions instead of silently restoring or detaching somebody's work.
  const status = await execGit(['status', '--porcelain', '--untracked-files=no'], existingWorktreePath)
    .then(r => r.stdout)
    .catch(() => null);
  if (status === null) {
    console.warn(`⚠️ Cannot adopt worktree for ${agentId} — status unreadable; preserved for recovery`);
    return null;
  }
  const trackedChanges = status.split(/\r?\n/).filter(Boolean);
  const deletions = trackedChanges.filter(line => line.startsWith(' D ')).length;
  if (deletions >= 100 && deletions > trackedChanges.length / 2) {
    console.warn(`⚠️ Cannot adopt worktree for ${agentId} — ${deletions} unstaged tracked deletions suggest an interrupted removal; preserved for recovery`);
    return null;
  }

  // Re-entered prep still needs the damage check before resuming in place.
  if (pathsEqual(existingWorktreePath, targetPath)) return adopted;

  await ensureDir(WORKTREES_DIR);

  if (options.deepResume) {
    try {
      const entries = (await execGit(['ls-files', '--stage'], existingWorktreePath)).stdout;
      if (/^160000 /m.test(entries)) {
        // Git cannot move linked worktrees containing submodules, even after
        // deinit. Preserve the admitted inactive tree intact and transfer only
        // its clean branch attachment, all under the same repository queue.
        const currentBranch = (await execGit(['symbolic-ref', '--short', 'HEAD'], existingWorktreePath)).stdout.trim();
        const head = (await execGit(['rev-parse', 'HEAD'], existingWorktreePath)).stdout.trim();
        const status = (await execGit(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], existingWorktreePath)).stdout.trim();
        const listed = await listWorktrees(sourceWorkspace);
        // Git and Node can spell the same Windows directory differently. Fall
        // back to filesystem identity, never case-fold or guess at ownership.
        const identity = await stat(existingWorktreePath, { bigint: true }).catch(() => null);
        const matches = [];
        for (const entry of listed) {
          if (pathsEqual(entry.path, existingWorktreePath)) { matches.push(entry); continue; }
          const other = await stat(entry.path, { bigint: true }).catch(() => null);
          if (identity?.isDirectory() && other?.isDirectory() && typeof identity.ino === 'bigint' && identity.ino > 0n &&
            identity.dev === other.dev && identity.ino === other.ino) matches.push(entry);
        }
        const holder = matches.length === 1 ? matches[0] : null;
        const refusal = currentBranch !== branchName ? 'branch identity changed'
          : !holder ? 'worktree registration could not be matched'
            : holder.locked ? 'worktree is locked' : status ? 'workspace has uncommitted or nested changes' : null;
        if (refusal) throw new Error(`Retained Deep submodule ${refusal}; preserve it for explicit recovery`);
        await execGit(['checkout', '--detach', head], existingWorktreePath);
        const branchHead = (await execGit(['rev-parse', `refs/heads/${branchName}`], sourceWorkspace)).stdout.trim();
        if (branchHead !== head) throw new Error('Deep resume branch changed during handoff; preserved old workspace');
        const replacement = await createWorktreeUnlocked(agentId, sourceWorkspace, null, { existingBranch: branchName });
        return { ...replacement, adopted: true };
      }
    } catch (error) {
      throw Object.assign(new Error(`Deep submodule handoff stopped; retained work is preserved: ${error.message}`, { cause: error }), { code: 'DEEP_RESUME_PRESERVED' });
    }
  }

  // Through the retry wrapper, not raw execGit: `worktree move` mutates the same
  // `.git/worktrees` bookkeeping whose per-repo lock motivated the retry (#2193).
  const moved = await addWorktreeWithRetry(['worktree', 'move', existingWorktreePath, targetPath], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Worktree adopt failed for ${agentId} (${existingWorktreePath} → ${targetPath}): ${err.message}`);
      return false;
    });
  if (!moved) return null;

  // Mirror removeWorktree's treatment of auto-generated lockfile churn: it discards
  // those changes rather than preserving them, so an adopted tree must not carry
  // them either. The resume prompt tells the retry that everything uncommitted is
  // its own in-progress work to finish and commit — which would ship a
  // `package-lock.json` bump from the dead run's `npm install` that nobody
  // intended. Only when the churn is ALL there is: a tree with real changes keeps
  // everything, exactly as removeWorktree preserves it.
  const porcelain = await execGit(['status', '--porcelain'], targetPath)
    .then(r => r.stdout.trim())
    .catch(() => '');
  const dirt = classifyWorktreeDirt(porcelain, { preserveLockfiles: options.preserveLockfiles === true });
  if (dirt.lockfileOnly) {
    console.log(`🧹 Discarding ${dirt.lockfilePaths.length} auto-generated lockfile change(s) in adopted worktree ${agentId}`);
    await discardLockfileChanges(targetPath, dirt).catch(err => {
      console.log(`⚠️ Lockfile discard failed in adopted worktree ${agentId}: ${err.message}`);
    });
  }

  console.log(`🌳 Adopted worktree for ${agentId} at ${targetPath} (branch: ${branchName}) — resuming interrupted work`);
  return adopted;
}

/**
 * The ref a "has this branch landed?" question should be asked against.
 *
 * NOT the local default branch. A PR merged on the forge moves ORIGIN's default
 * branch; this clone's `main` does not move until something fetches. So a branch
 * whose PR merged minutes ago reads as unmerged against the local ref, and a
 * caller that preserves on "unmerged" keeps an already-landed branch — which is
 * how a merged review-loop task was re-queued against work that had shipped.
 *
 * Refreshing first is best-effort: a fetch that fails (offline, no remote) falls
 * back to the local branch, which is strictly what the caller had before.
 *
 * @param {string} sourceWorkspace
 * @param {string} defaultBranch
 * @returns {Promise<string>} `origin/<default>` when resolvable, else `<default>`
 */
async function resolveMergeTarget(sourceWorkspace, defaultBranch) {
  await execGit(['fetch', 'origin', '--prune'], sourceWorkspace, { ignoreExitCode: true }).catch(() => {});
  const remote = await execGit(['rev-parse', '--verify', `origin/${defaultBranch}^{commit}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? `origin/${defaultBranch}` : null))
    .catch(() => null);
  return remote || defaultBranch;
}

// Branch recovery is independent of checkout recovery. A second cleanup can
// arrive after the first removed the directory but preserved unpublished work;
// every successful removal path must apply the same branch-retention policy.
async function cleanupWorktreeBranch(sourceWorkspace, branchName, {
  hasUnmergedCommits = false, warnings, expectedHead, target: resolvedTarget,
}) {
  const present = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  if (present?.exitCode === 1) return;
  if (present?.exitCode !== 0) {
    warnings.push(`Branch ${branchName} preserved — ref state unavailable`);
    return;
  }
  // Pin even a branch whose checkout was already removed. Unknown or changed
  // refs stay available for recovery instead of falling through to branch -D.
  const currentHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace).catch(() => null))?.stdout?.trim();
  expectedHead ||= currentHead;
  if (!expectedHead || currentHead !== expectedHead) {
    warnings.push(`Branch ${branchName} preserved — current head unavailable or changed`);
    return;
  }
  if (!hasUnmergedCommits) {
    // A prior cleanup may have already deleted a landed branch. Confirmed
    // absence is a clean no-op; an unreadable ref is still work to preserve.
    const localRef = await execGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      sourceWorkspace, { ignoreExitCode: true },
    ).catch(() => null);
    if (localRef?.exitCode === 1) return;
    const { getDefaultBranch, hasBranchMergeEvidence } = await import('./git.js');
    const defaultBranch = await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
    // A caller holding the claim-ownership lock passes a target it resolved earlier:
    // the fetch must not run under that lock (#12764), and merge evidence against a
    // ref fetched moments ago stays valid.
    const target = resolvedTarget || await resolveMergeTarget(sourceWorkspace, defaultBranch);
    // Patch-equivalence recognizes squash/rebase merges; a failed probe keeps
    // the branch. Ask the refreshed remote target so a landed PR is not resumed
    // just because this install's local default branch has not advanced.
    const hasMergeEvidence = localRef?.exitCode === 0
      && await hasBranchMergeEvidence(sourceWorkspace, branchName, target).catch(() => false);
    if (!hasMergeEvidence) {
      hasUnmergedCommits = true;
      console.log(`🌳 Preserving branch ${branchName} — merge evidence into ${target} was not established, kept so a retry can resume from it`);
      warnings.push(`Branch ${branchName} preserved — merge evidence was not established; kept for a retry`);
    } else {
      const ahead = parseInt((await execGit(
        ['rev-list', '--count', `${target}..${branchName}`],
        sourceWorkspace,
      ).catch(() => ({ stdout: '' }))).stdout.trim(), 10);
      console.log(ahead === 0
        ? `🌳 Branch ${branchName} has no commits beyond ${target} — deleting it`
        : `🌳 Branch ${branchName} is already merged into ${target} — safe to delete`);
    }
  }
  if (hasUnmergedCommits) {
    console.warn(`⚠️ Preserving worktree branch ${branchName} for manual/automated recovery`);
  } else {
    const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
    const policy = await readBranchCompletionHold({ repoPath: sourceWorkspace, branch: branchName, retirement: true }).catch(() => 'pr-completion-policy-unavailable');
    if (policy) { warnings.push(`Branch ${branchName} preserved — ${policy}`); return; }
    const recoveryRef = await execGit(['update-ref', `refs/portos/completed/${expectedHead}`, expectedHead], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
    if (recoveryRef?.exitCode !== 0 || !await deleteCompletedLocalBranch(sourceWorkspace, branchName, expectedHead)) {
      warnings.push(`Branch ${branchName} preserved — head changed, new holder, or deletion refused`);
    }
  }
}

/**
 * Remove a git worktree and its associated branch.
 *
 * Called during agent cleanup. Merges the worktree branch back
 * to the source branch if the agent made commits, then prunes.
 *
 * @param {string} agentId - The agent identifier
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} branchName - The worktree branch to clean up
 * @param {object} options
 * @param {boolean} [options.merge] - attempt to merge the branch back first
 * @param {boolean} [options.preserveLockfiles] - keep a lockfile-only change (a
 *   `dependency-updates` deliverable) instead of discarding it as install churn
 * @param {boolean} [options.discardDirt] - remove even when the tree is dirty.
 *   The dirty-abort exists to protect work that might still be wanted; the
 *   throwaway-worktree posture has already declared this tree's contents
 *   worthless (its own prompt invites scratch edits and forbids committing), so
 *   for it the abort protects nothing and instead strands a full checkout per
 *   run, forever. ONLY the discard path may pass this.
 */
export async function removeWorktree(agentId, sourceWorkspace, branchName, options = {}) {
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const ownershipHold = async () => claimCheckoutOwnerReason({
    branchName, holderPath: join(WORKTREES_DIR, agentId), sourceWorkspace,
    agents: await readClaimOwnershipAgents().catch(() => null), ignoreIds: [agentId],
  });
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(sourceWorkspace,
    () => removeWorktreeNow(agentId, sourceWorkspace, branchName, options, ownershipHold));
}

/**
 * Runs cleanup as claim-ownership critical sections with every archive between two
 * of them (#12748): each archive hashes and copies the whole checkout, and every
 * bind/release/reserve queues behind that lock on a 15 s budget. While an archive
 * runs this checkout is fenced; each section re-reads the owners before it acts.
 * `ownershipHold` reads registered owners only — this function owns the fence check.
 */
async function removeWorktreeNow(agentId, sourceWorkspace, branchName, options, ownershipHold) {
  const { withClaimOwnershipLock, checkoutRetirementFenceReason, retireWithUnlockedArchive } = await import('./cosClaimOwnershipState.js');
  const worktreePath = join(WORKTREES_DIR, agentId);
  const fence = { repoPath: sourceWorkspace, path: worktreePath, branch: branchName };
  const warnings = [];
  let merged = false;
  let commitsAhead = 0;
  let mergeRefused = false;
  const held = reason => {
    warnings.push(`Worktree preserved — ${reason}`);
    return { merged, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings };
  };
  // Fetched with the lock released (archive phase, or before the first section) and
  // reused by every check under the lock: a branch merged into origin/<default> stays merged.
  let mergeTarget;
  const completionHold = async (expectedHead) => {
    const owner = await ownershipHold();
    if (owner) return owner;
    const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
    const policy = await readBranchCompletionHold({ repoPath: sourceWorkspace, branch: branchName, retirement: true });
    if (policy) return policy;
    const { getDefaultBranch, hasBranchMergeEvidence } = await import('./git.js');
    const base = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
    if (!base) return 'default-branch-unavailable';
    if (PROTECTED_BRANCHES.includes(branchName) || branchName === base) return 'protected-branch';
    mergeTarget ||= await resolveMergeTarget(sourceWorkspace, base);
    const head = (await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace).catch(() => null))?.stdout?.trim();
    if (!head || (expectedHead && head !== expectedHead)) return 'branch-head-changed-or-unavailable';
    return await hasBranchMergeEvidence(sourceWorkspace, head, mergeTarget).catch(() => false) ? null : 'merge-evidence-unavailable';
  };
  // A follow-up on a branch the primary checkout owns runs DETACHED (createWorktree):
  // there is no branch to protect, merge or delete, so only its commits matter.
  // Probed lazily: every early refusal above the archive step is a pure-status exit.
  let detachedProbe = null;
  const detachedCheckout = () => detachedProbe ||= listWorktrees(sourceWorkspace)
    .then(trees => trees.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath) && wt.detached && !wt.branch) || null, () => null);
  const detachedHold = async (head) => {
    const owner = await ownershipHold();
    if (owner) return owner;
    const contained = await execGit(['branch', '-r', '--contains', head], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
    return contained?.exitCode === 0 && contained.stdout.trim() ? null : 'detached-head-unpublished';
  };
  const ignoredPaths = [DONE_SENTINEL_NAME, ...doneSentinelCandidateNames(agentId)];
  // Observe the checkout under the fence and return the gate removal re-runs.
  const admitRemoval = async () => {
    const tree = (await listWorktrees(sourceWorkspace)).find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath));
    const detached = Boolean(await detachedCheckout());
    if (!tree || (detached ? !tree.detached || tree.branch : tree.branch !== `refs/heads/${branchName}`)) throw new Error('worktree-holder-changed');
    const checkHold = detached ? detachedHold : completionHold;
    const hold = await checkHold(tree.head);
    if (hold) throw new Error(hold);
    const { readRetirementCheckoutIdentity } = await import('../lib/retirementCheckoutObservation.js');
    const checkoutIdentity = await readRetirementCheckoutIdentity(tree.path).catch(() => null);
    return {
      head: tree.head, path: tree.path, branch: detached ? null : branchName,
      integrationTarget: mergeTarget ? (await execGit(['rev-parse', '--verify', `${mergeTarget}^{commit}`], sourceWorkspace)).stdout.trim() : null,
      ...(checkoutIdentity && { checkoutIdentity }),
      verify: async holder => {
        if (!holder || holder.head !== tree.head || Boolean(holder.detached) !== Boolean(tree.detached)) return 'worktree-holder-changed';
        if (!detached && holder.branch !== tree.branch) return 'worktree-holder-changed';
        const again = await checkHold(tree.head);
        if (again) return again;
        if (delivered || !existsSync(tree.path)) return null;
        const status = await execGit(['status', '--porcelain'], tree.path).then(r => r.stdout, () => null);
        if (status === null) return 'worktree-status-unavailable';
        const dirt = classifyWorktreeDirt(status, { ignoredPaths, preserveLockfiles: options.preserveLockfiles === true });
        if (!dirt.clean && !options.discardDirt) return 'worktree-dirty';
        return null;
      },
    };
  };
  // One removal between two critical sections. `admit` (under the lock, after the
  // owner re-read) returns a result to stop before fencing; `finish` runs under the
  // lock again with the fence still held.
  const retire = ({ admit = async () => null, onArchiveFailure, finish }) => retireWithUnlockedArchive({
    busy: () => held('checkout-retirement-reserved'),
    admit: async () => {
      const owner = await ownershipHold();
      if (owner) return { result: held(owner) };
      const stop = await admit();
      return stop ? { result: stop } : { fence };
    },
    archive: () => admitRemoval().then(archive => ({ archive }), error => {
      warnings.push(`Worktree preserved — ${error.message}`);
      return { result: onArchiveFailure() };
    }),
    finish: (_admitted, preservation) => finish(preservation),
  });
  const cleanupBranch = async (expectedHead) => {
    const finalOwner = await ownershipHold();
    if (finalOwner) {
      warnings.push(`Branch ${branchName} preserved — ${finalOwner}`);
      return false;
    }
    await cleanupWorktreeBranch(sourceWorkspace, branchName, {
      hasUnmergedCommits: options.merge && !merged && (commitsAhead > 0 || mergeRefused), warnings, expectedHead, target: mergeTarget,
    });
    return true;
  };

  if (!existsSync(worktreePath)) {
    // The already-gone path deletes the branch under the lock; fetch before taking it.
    const { getDefaultBranch } = await import('./git.js');
    const base = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
    if (base) mergeTarget = await resolveMergeTarget(sourceWorkspace, base);
  }
  // Once the branch's PR merged at this exact tip, its checkout is disposable:
  // uncommitted and untracked files go with it. Asked before the lock (a forge
  // call); removal still re-proves merge evidence against the observed head.
  const { isBranchTipMergedByPr } = await import('./prProbe.js');
  // A detached follow-up never inherits its primary branch's delivery.
  const delivered = existsSync(worktreePath)
    && await isBranchTipMergedByPr(sourceWorkspace, branchName).catch(() => false) && !await detachedCheckout();

  const inspected = await withClaimOwnershipLock(async () => {
    const { getDefaultBranch } = await import('./git.js');
    const defaultBranch = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
    const protectedReason = PROTECTED_BRANCHES.includes(branchName) || branchName === defaultBranch
      ? 'protected-branch' : !defaultBranch ? 'default-branch-unavailable' : null;
    if (protectedReason && !await detachedCheckout()) return { result: held(protectedReason) };
    // A retirement archiving this checkout with the lock released owns it until removal.
    const owner = checkoutRetirementFenceReason(fence) || await ownershipHold();
    if (owner) return { result: held(owner) };

    if (!existsSync(worktreePath)) {
      // The directory is gone, but git may still register it (a stale entry pins the
      // branch). Verify rather than assume; prune when the registration survives.
      const gone = removalOutcome(worktreePath, await probeWorktreeRemoval(sourceWorkspace, worktreePath));
      if (!gone.removed) return { missing: true };
      console.log(`🌳 Worktree already removed for ${agentId}, cleaning up branch`);
      await cleanupBranch(undefined);
      return { result: { merged: false, removed: true, uncommittedSaved: false, warnings } };
    }

    // Verify the worktree still points to the correct repo before trusting git status.
    // If the .git file is missing (e.g., worktree was partially cleaned up), git walks up
    // the directory tree and may find a parent repo (e.g., PortOS) instead of the app repo.
    // In that case, even a successful git status describes the wrong checkout and
    // cannot prove this directory has no unique work.
    const detectedToplevel = await execGit(['rev-parse', '--show-toplevel'], worktreePath)
      .then(r => r.stdout.trim())
      .catch(() => null);
    // Compare realpath-resolved forms so symlinks (e.g. macOS /var → /private/var)
    // or normalization differences don't false-positive as a broken worktree.
    if (detectedToplevel && !pathsEqual(detectedToplevel, worktreePath)) {
      warnings.push('Worktree preserved — broken checkout identity prevents verifying its contents');
      console.warn(`⚠️ Worktree ${agentId} has a broken checkout identity; preserving its directory and branch`);
      return { result: { merged: false, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings } };
    }

    // A merged delivery's uncommitted and ignored files are discarded with its
    // checkout; only an unmerged checkout is held for them.
    if (delivered) return {};

    // Safety check: abort removal when uncommitted changes are detected.
    // Also fail closed if git status itself fails — treat unknown state as dirty.
    let dirtyFiles;
    try {
      dirtyFiles = (await execGit(['status', '--porcelain'], worktreePath)).stdout.trim();
    } catch (err) {
      console.log(`⚠️ git status failed for worktree ${agentId}, preserving to avoid data loss: ${err.message}`);
      warnings.push(`Worktree preserved — git status failed: ${err.message}`);
      return { result: { merged: false, removed: false, uncommittedSaved: false, warnings } };
    }
    // The completion sentinel is not authored work: it has already been consumed
    // by finalizeAgent before this cleanup runs. Ignore it for the preservation
    // decision, while still preserving the tree if any real change remains; the
    // eventual forced worktree removal discards it with the rest of the completed
    // checkout. The run's canonical name and its bounded truncation-recovery
    // name, plus the legacy shared one a pre-upgrade run may have left — and no
    // other agent's.
    const dirt = classifyWorktreeDirt(dirtyFiles, {
      ignoredPaths,
      preserveLockfiles: options.preserveLockfiles === true
    });
    if (!dirt.clean && options.discardDirt) {
      // Throwaway posture: the caller has already established that nothing in this
      // tree is wanted. Log what is being dropped so a surprising loss is at least
      // traceable, then fall through to removal.
      const shown = dirt.realChangePaths.slice(0, DIRT_PATHS_IN_WARNING);
      if (shown.length) console.log(`🌳 Discarding uncommitted changes in throwaway worktree ${agentId}: ${shown.join(', ')}`);
    } else if (!dirt.clean) {
      // Auto-generated lockfile changes agents don't intend to commit (e.g. npm
      // install resolving ^version to an exact version) are discarded below.
      if (dirt.lockfileOnly) return { lockfile: { dirt, dirtyFiles } };
      // NAME the dirty paths. The bare message reads as "your work was left
      // behind" with no way to tell real uncommitted work from a transient
      // observation, and the worktree is usually gone by the time anyone looks —
      // which is exactly what made the duplicate-cleanup race in
      // `agentWorktreeCleanup.js` undiagnosable from the card alone.
      const shown = dirt.realChangePaths.slice(0, DIRT_PATHS_IN_WARNING);
      const more = dirt.realChangePaths.length - shown.length;
      const detail = `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
      console.log(`⚠️ Preserving worktree for ${agentId} — uncommitted changes detected (${detail}), aborting cleanup to avoid data loss`);
      warnings.push(`Worktree preserved — uncommitted changes detected in ${worktreePath}: ${detail}`);
      return { result: { merged: false, removed: false, uncommittedSaved: false, warnings } };
    }
    return {};
  });
  if (inspected.result) return inspected.result;

  if (inspected.missing) {
    return retire({
      onArchiveFailure: () => ({ merged: false, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings }),
      finish: async (preservation) => {
        const gone = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, { verifyRemoval: preservation.verify });
        if (!gone.removed) {
          warnings.push(gone.warning);
          return { merged: false, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings };
        }
        console.log(`🌳 Worktree already removed for ${agentId}, cleaning up branch`);
        await cleanupBranch(preservation.head);
        return { merged: false, removed: true, uncommittedSaved: false, warnings };
      },
    });
  }

  if (inspected.lockfile) {
    const { dirt, dirtyFiles } = inspected.lockfile;
    // Preserve the original bytes before the intentional lockfile cleanup.
    // The second snapshot below guards the post-cleanup removal boundary.
    const discardFailure = await retire({
      onArchiveFailure: () => ({ merged: false, removed: false, uncommittedSaved: false, warnings }),
      finish: async () => {
        // The snapshot ran with the lock released; discard only the tree it captured.
        const current = await execGit(['status', '--porcelain'], worktreePath).then(r => r.stdout.trim(), () => null);
        if (current !== dirtyFiles) {
          warnings.push(`Worktree preserved — ${worktreePath} changed after its lockfile cleanup was admitted`);
          return { merged: false, removed: false, uncommittedSaved: false, warnings };
        }
        console.log(`🧹 Discarding ${dirt.lockfilePaths.length} auto-generated lockfile change(s) in worktree ${agentId}`);
        // Never throws past removeWorktree: an undiscardable lockfile keeps the tree.
        return discardLockfileChanges(worktreePath, dirt).then(() => null, err => {
          console.log(`⚠️ Lockfile discard failed in worktree ${agentId}, preserving to avoid data loss: ${err.message}`);
          warnings.push(`Worktree preserved — lockfile discard failed in ${worktreePath}: ${err.message}`);
          return { merged: false, removed: false, uncommittedSaved: false, warnings };
        });
      },
    });
    if (discardFailure) return discardFailure;
  }

  return retire({
    admit: async () => {
      if (!options.merge || await detachedCheckout()) return null;
      const currentBranch = (await execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        sourceWorkspace
      )).stdout.trim();

      // Defense-in-depth: NEVER merge the agent branch into a non-default branch.
      // See shouldRefuseDefaultBranchMerge for the rationale.
      const { getDefaultBranch } = await import('./git.js');
      const defaultBranch = await getDefaultBranch(sourceWorkspace).catch(() => null);
      if (shouldRefuseDefaultBranchMerge(currentBranch, defaultBranch)) {
        console.log(`🌳 Refusing auto-merge of ${branchName} into '${currentBranch}' (default branch is '${defaultBranch || 'unknown'}'). Use \`gh pr merge\` for non-default targets.`);
        warnings.push(`Auto-merge skipped — source repo HEAD is on '${currentBranch}', not default '${defaultBranch || 'unknown'}'. Branch ${branchName} preserved for manual review.`);
        mergeRefused = true;
        return null;
      }
      const countResult = await execGit(
        ['rev-list', '--count', `${currentBranch}..${branchName}`],
        sourceWorkspace,
        { ignoreExitCode: true },
      ).catch(() => null);
      const countText = countResult?.stdout?.trim();
      const parsedCount = typeof countText === 'string' && /^\d+$/.test(countText)
        ? Number(countText)
        : NaN;

      // A failed or malformed preflight cannot prove that the branch is empty.
      // Keep both refs in place so retry can safely decide whether to merge.
      if (countResult?.exitCode !== 0 || !Number.isSafeInteger(parsedCount)) {
        console.warn(`⚠️ Could not determine commits ahead for ${branchName}; preserving its worktree and branch for retry`);
        warnings.push(`Worktree and branch ${branchName} preserved — could not read a valid commit count; retry cleanup when Git refs are available`);
        return { merged: false, removed: false, uncommittedSaved: false, warnings };
      }

      commitsAhead = parsedCount;

      if (commitsAhead > 0) {
        await execGit(['merge', branchName, '--no-edit'], sourceWorkspace)
          .then(() => { merged = true; })
          .catch(async (err) => {
            console.log(`⚠️ Could not auto-merge ${branchName}: ${err.message}`);
            await execGit(['merge', '--abort'], sourceWorkspace).catch(() => {});
            warnings.push(`Auto-merge failed for branch ${branchName} — branch preserved for manual recovery`);
          });
      }
      return null;
    },
    onArchiveFailure: () => ({ merged, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings }),
    finish: async (preservation) => {
      const removal = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
        verifyRemoval: preservation.verify,
        label: `Worktree remove failed for ${agentId}, falling back to manual cleanup`,
        log: 'all',
        subject: agentId,
      });
      if (!removal.removed) {
        // The checkout (or its registration) survived: the branch is still held, so
        // deleting it would fail, and `removed: true` would tell the caller it may
        // queue work onto a branch the old worktree still owns. Report the truth with
        // a retryable warning; `merged` stays accurate for the publication outcome.
        // `forceRemoveWorktreeDir` above already reported why on the right stream.
        console.log(`⏸️ Worktree for ${agentId} was not removed — branch ${branchName} kept`);
        warnings.push(removal.warning);
        return { merged, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings };
      }

      // Merge evidence and completion policy were checked before removal; the
      // branch helper checks them again before its leased local deletion.
      const branchCleaned = await detachedCheckout() || await cleanupBranch(preservation.head);
      if (branchCleaned) console.log(`🌳 Removed worktree for ${agentId}${merged ? ' (merged)' : ''}`);
      const { recordWorkspaceCheckoutRetirement } = await import('./branchReconcileOutcome.js');
      // A completed cleanup attempt may retain a moved or newly held branch.
      const ref = preservation.branch && await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${preservation.branch}`],
        sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
      await recordWorkspaceCheckoutRetirement(sourceWorkspace, {
        path: preservation.path, branch: preservation.branch, head: preservation.head,
        branchDeleted: ref?.exitCode === 1,
        // A detached checkout has no branch to delete; its receipt says so instead of claiming one.
        ...(!preservation.branch && { checkoutOnly: true }),
        ...(preservation.checkoutIdentity && { checkoutIdentity: preservation.checkoutIdentity }),
      }).catch(error => { warnings.push(`Retirement receipt not recorded: ${error.message}`); });
      return { merged, removed: true, uncommittedSaved: false, warnings };
    },
  });
}

/**
 * Create a persistent worktree for a feature agent.
 * Unlike regular worktrees, these persist across runs.
 */
export async function createPersistentWorktree(featureAgentId, sourceWorkspace, branchName, baseBranch) {
  // Share the per-repo serialization tail with createWorktree so a persistent
  // feature-agent add and a CoS agent add in the same tick can't race git's
  // per-repo worktree lock (#2193).
  return queueWorktreeCreate(sourceWorkspace, () => createPersistentWorktreeUnlocked(featureAgentId, sourceWorkspace, branchName, baseBranch));
}

async function createPersistentWorktreeUnlocked(featureAgentId, sourceWorkspace, branchName, baseBranch) {
  const FA_WORKTREES = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  await ensureDir(join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId));

  const fetchOk = await execGit(['fetch', 'origin'], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Persistent worktree fetch failed: ${err.message}`);
      return false;
    });

  if (!baseBranch) {
    const { getDefaultBranch } = await import('./git.js');
    baseBranch = await getDefaultBranch(sourceWorkspace, { allowRemote: fetchOk }).catch(() => null) || 'main';
  }

  // Verify the base branch exists locally or on the remote; re-detect if stale
  const baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
    .then(() => `origin/${baseBranch}`)
    .catch(async () => {
      const localExists = (await execGit(['branch', '--list', baseBranch], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
      if (localExists) return baseBranch;
      // Provided baseBranch doesn't exist — re-detect the actual default
      const { getDefaultBranch } = await import('./git.js');
      const detected = await getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null);
      if (detected && detected !== baseBranch) {
        baseBranch = detected;
        const remoteOk = await execGit(['rev-parse', `origin/${detected}`], sourceWorkspace, { ignoreExitCode: true })
          .then(r => r.exitCode === 0).catch(() => false);
        if (remoteOk) return `origin/${detected}`;
        const localOk = (await execGit(['branch', '--list', detected], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
        if (localOk) return detected;
      }
      // All detection failed — use HEAD and update baseBranch to reflect reality
      const headBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
      baseBranch = headBranch && headBranch !== 'HEAD' ? headBranch : baseBranch;
      return 'HEAD';
    });

  // Check if branch already exists (local or remote)
  const localBranchExists = (await execGit(['branch', '--list', branchName], sourceWorkspace)).stdout.trim();
  const remoteBranchExists = (await execGit(['branch', '-r', '--list', `origin/${branchName}`], sourceWorkspace)).stdout.trim();

  if (localBranchExists) {
    // Local branch exists - create worktree from existing branch (no orphan
    // cleanup: the branch pre-dates this add).
    await addWorktreeWithRetry(['worktree', 'add', FA_WORKTREES, branchName], sourceWorkspace);
  } else if (remoteBranchExists) {
    // Remote branch exists but no local - track it. On final failure, drop the
    // partially-created local tracking branch (it re-creates from origin next run).
    await addWorktreeWithRetry(['worktree', 'add', '--track', '-b', branchName, FA_WORKTREES, `origin/${branchName}`], sourceWorkspace)
      .catch(async (err) => { await cleanupOrphanBranch(sourceWorkspace, branchName, err); throw err; });
  } else {
    // New branch - create from base. `--no-track` for the same reason as createWorktree:
    // `baseRef` is usually `origin/<default>`, and an auto-configured
    // `branch.<name>.merge = refs/heads/main` turns a config-derived push into a push
    // onto the default branch (#4172). Clean up the orphan branch on final failure (#2193).
    await addWorktreeWithRetry(['worktree', 'add', '--no-track', '-b', branchName, FA_WORKTREES, baseRef], sourceWorkspace)
      .catch(async (err) => { await cleanupOrphanBranch(sourceWorkspace, branchName, err); throw err; });
  }

  // Covers all three arms above, including a branch a prior run left mis-tracked.
  await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, FA_WORKTREES, { deleteBranch: !localBranchExists });

  console.log(`🌳 Created persistent worktree for feature agent ${featureAgentId} at ${FA_WORKTREES} (branch: ${branchName})`);
  return { worktreePath: FA_WORKTREES, branchName, baseBranch };
}

/**
 * Remove a persistent feature agent worktree
 */
export async function removePersistentWorktree(featureAgentId, sourceWorkspace, branchName) {
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(sourceWorkspace, () => removePersistentWorktreeAdmitted(featureAgentId, sourceWorkspace, branchName));
}

async function removePersistentWorktreeAdmitted(featureAgentId, sourceWorkspace, branchName) {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  if (!existsSync(worktreePath)) return { removed: false };

  const removal = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
    label: `Persistent worktree remove failed for ${featureAgentId}, falling back`,
    log: 'all',
    subject: featureAgentId,
  });
  if (!removal.removed) return { removed: false, cleanupIncomplete: true, warnings: [removal.warning] };

  await execGit(['branch', '-D', branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
  });

  console.log(`🌳 Removed persistent worktree for feature agent ${featureAgentId}`);
  return { removed: true, warnings: [] };
}

/**
 * Merge base branch into a persistent feature agent worktree before a run
 */
export async function mergeBaseIntoFeatureWorktree(featureAgentId, baseBranch) {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');
  if (!existsSync(worktreePath)) return { merged: false, reason: 'worktree-missing' };

  const fetchOk = await execGit(['fetch', 'origin'], worktreePath)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Fetch failed for feature agent ${featureAgentId}: ${err.message}`);
      return false;
    });

  if (!baseBranch) {
    const { getDefaultBranch } = await import('./git.js');
    baseBranch = await getDefaultBranch(worktreePath, { allowRemote: fetchOk }).catch(() => null) || 'main';
  }
  // Verify origin/<baseBranch> exists; if not, re-detect before giving up
  let remoteBranchValid = await execGit(['rev-parse', `origin/${baseBranch}`], worktreePath, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  if (!remoteBranchValid) {
    const { getDefaultBranch } = await import('./git.js');
    const detected = await getDefaultBranch(worktreePath, { allowRemote: false }).catch(() => null);
    if (detected && detected !== baseBranch) {
      remoteBranchValid = await execGit(['rev-parse', `origin/${detected}`], worktreePath, { ignoreExitCode: true })
        .then(r => r.exitCode === 0).catch(() => false);
      if (remoteBranchValid) {
        baseBranch = detected;
      }
    }
    if (!remoteBranchValid) {
      return { merged: false, reason: `origin/${baseBranch} not found` };
    }
  }
  const result = await execGit(['merge', `origin/${baseBranch}`, '--no-edit'], worktreePath)
    .then(() => ({ merged: true }))
    .catch(async (err) => {
      // Abort failed merge
      await execGit(['merge', '--abort'], worktreePath).catch(abortErr => {
        console.log(`⚠️ Merge abort failed for ${featureAgentId}: ${abortErr.message}`);
      });
      return { merged: false, reason: err.message };
    });

  if (result.merged) {
    console.log(`🌳 Merged origin/${baseBranch} into feature agent ${featureAgentId}`);
  }
  return result;
}

/**
 * List all active worktrees for the repository.
 *
 * Split on CRLF as well as LF. On Windows git's porcelain output is CRLF, and a
 * bare `split('\n')` leaves a trailing \r on every value: `path` and `branch`
 * silently carry it, so containment checks and path equality match nothing, and
 * the flag lines never compare equal (`'bare\r' !== 'bare'`) so `bare`,
 * `detached`, `locked` and `prunable` all read as false. That is what made the
 * reaper report a managed worktree as `worktree-unmanaged-location` on Windows
 * and skip it forever, while every Linux run stayed green.
 */
export async function listWorktrees(sourceWorkspace) {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], sourceWorkspace);
  const worktrees = [];
  let current = {};

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      // `git worktree list --porcelain` emits a bare `locked` line, or `locked <reason>`.
      current.locked = true;
      current.lockReason = line.startsWith('locked ') ? line.slice(7) : null;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // Same two spellings. Set when git considers the registration disposable —
      // its directory is gone, or its .git pointer no longer resolves.
      current.prunable = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

// Registry the destructive passes re-read under the claim-ownership lock.
// Omitted reads state.json; `{ agents }` / `{ readAgents }` inject owners.
function claimOwnerReader(claimOwners, readClaimOwnershipAgents) {
  return claimOwners === undefined ? readClaimOwnershipAgents
    : async () => claimOwners?.readAgents ? claimOwners.readAgents().catch(() => null) : claimOwners?.agents;
}

// A liveness snapshot ages while the caller's earlier passes run, so the orphan
// passes re-read it per tree (#11858). A bare Set/null is a fixed snapshot.
function activeIdsReader(activeIds) {
  return typeof activeIds === 'function' ? activeIds : () => activeIds;
}

/**
 * Clean up any orphaned worktrees (worktrees whose agent no longer exists)
 *
 * @param {string} sourceWorkspace - The original git repository path
 * @param {(() => Set<string>|null)|Set<string>|null} getActiveIds - live agent ids, re-read
 *   for every worktree. Anything but a Set reads as "liveness unknown" and holds every `agent-*` tree.
 * @param {object} [options]
 * @param {{agents?: object[]|null, readAgents?: () => Promise<object[]|null>}} [options.claimOwners] -
 *   agent registry override (tests); omitted reads state.json
 * @param {Set<string>} [options.retainedPaths] - registered paths held by an earlier cleanup pass
 */
export async function cleanupOrphanedWorktrees(sourceWorkspace, getActiveIds, { claimOwners, retainedPaths = new Set() } = {}) {
  if (!existsSync(WORKTREES_DIR)) return 0;

  const readActiveIds = activeIdsReader(getActiveIds);
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  const readOwners = claimOwnerReader(claimOwners, readClaimOwnershipAgents);
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
  let cleaned = 0;

  // Track which agent dirs we handle via git worktree list (PortOS-owned worktrees)
  const handledAgentIds = new Set();

  for (const wt of worktrees) {
    const ownershipReason = () => worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds: readActiveIds(),
      roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
      requireKnownLiveness: true,
    });
    const initialReason = ownershipReason();
    if (initialReason === 'worktree-unmanaged-location') continue;
    const agentId = worktreeAgentId(wt.path);
    handledAgentIds.add(agentId);
    if (retainedPaths.has(wt.path)) continue;
    if (initialReason) continue;
    // A detached HEAD has no branch to merge or measure; force-removing it would drop commits only its reflog holds.
    if (wt.detached || !wt.branch) continue;

    const branchName = wt.branch.replace('refs/heads/', '');
    // Attempt merge so committed work from preserved worktrees (e.g., PR/push failures) isn't lost.
    // If merge fails, the branch is preserved for manual recovery. Every critical
    // section re-reads liveness and the registry, so neither an agent dispatched
    // since the check above nor a registered claim owner loses its checkout.
    const result = await withCheckoutPublication(sourceWorkspace,
      () => removeWorktreeNow(agentId, sourceWorkspace, branchName, { merge: true }, async () =>
        ownershipReason() || claimCheckoutOwnerReason({ branchName, holderPath: wt.path, sourceWorkspace, agents: await readOwners() })),
    ).catch(err => {
      console.log(`⚠️ Failed to clean orphaned worktree ${agentId}: ${err.message}`);
      return { removed: false };
    });
    if (result?.removed) cleaned++;
  }

  // Scan for external-repo worktrees (directories whose .git points to a different repo).
  // These are invisible to `git worktree list` run against PortOS.
  cleaned += await cleanupExternalRepoWorktrees(readActiveIds, handledAgentIds, readOwners, retainedPaths);

  if (cleaned > 0) {
    console.log(`🌳 Cleaned ${cleaned} orphaned worktree(s)`);
  }

  return cleaned;
}

/**
 * Reap worktrees whose branch is fully merged into the default branch AND whose
 * working tree is clean. This is the SAFE counterpart to cleanupOrphanedWorktrees:
 * it never integrates unmerged work, never deletes anything with pending
 * changes, and honors worktree locks. A worktree is reaped only when BOTH hold:
 *   1. the working tree is completely clean, and
 *   2. every commit on the branch is already in the default branch — detected via
 *      `hasBranchMergeEvidence`, which covers normal AND squash/rebase merges.
 *
 * Because of gate (2) this works regardless of merge strategy, but a true merge
 * commit (see the `--merge`-preferring agent prompts) makes detection bulletproof.
 *
 * Covers both PortOS-managed CoS worktrees (`data/cos/worktrees/`) and the
 * `.claude/worktrees/` trees created by `/work`, `/claim`, and the superpowers
 * git-worktree skill (these share the PortOS repo, so they appear in
 * `git worktree list`). Active CoS agents and locked worktrees are never touched.
 *
 * Human `/claim` worktrees (`claim-*`) are ALWAYS skipped here, and deliberately
 * so — this reaper passes neither `allowStaleClaim` nor an age, which is not an
 * oversight to be fixed by handing it the same discriminator branch-reconcile
 * uses. Reclaiming a claim tree turns on how long it has been idle and on
 * whether its branch was provably SHIPPED (its upstream ref gone from origin),
 * and `branchReconcile` is the module that computes both, per branch, with the
 * remote-head listing to back it. This reaper knows only "merged + clean", which
 * is also true of a claim a human paused ten minutes ago. So the claim window
 * stays in ONE place: branch-reconcile reaps a shipped or abandoned claim on its
 * own pass, and the claim flow's Phase 7 self-cleans the ordinary case. (Under
 * `WORKTREES_DIR` the skip is doubly enforced: that root sets
 * `requireAgentId: true`, so a `claim-*` basename is refused as
 * `worktree-missing-agent-id` before the claim test is even reached.)
 *
 * @param {string} sourceWorkspace - repo root
 * @param {object} [options]
 * @param {Set<string>|(() => Set<string>)} [options.activeAgentIds] - CoS agents currently running
 *   (never reaped), or a getter re-read per tree and again before removal. Anything but a
 *   Set reads as "liveness unknown" and holds every `agent-*` tree.
 * @param {boolean} [options.includeClaudeTrees=true] - also reap `.claude/worktrees/`
 * @param {{agents?: object[]|null, readAgents?: () => Promise<object[]|null>}} [options.claimOwners] -
 *   trusted agent registry reader or snapshot; omitted reads state.json
 * @returns {Promise<{reaped: Array<{path,branch,locked,branchDeleted}>, skipped: Array<{path,branch,reason,warning?}>, defaultBranch: string, target: string}>}
 */
export async function reapMergedWorktrees(sourceWorkspace, {
  activeAgentIds = new Set(),
  claimOwners,
  includeClaudeTrees = true,
  appId = null
} = {}) {
  const { getDefaultBranch, hasBranchMergeEvidence } = await import('./git.js');
  const { readClaimOwnershipAgents, retireWithUnlockedArchive } = await import('./cosClaimOwnershipState.js');
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  // Every entry point (scheduled or reconcile) needs a trusted
  // registry. loadState/getAgents may default a corrupt file to empty state.
  const readOwners = claimOwnerReader(claimOwners, readClaimOwnershipAgents);
  const readActiveIds = activeIdsReader(activeAgentIds);

  const defaultBranch = await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  const target = await resolveMergeTarget(sourceWorkspace, defaultBranch);

  const currentBranch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true })
    .then(r => r.stdout.trim())
    .catch(() => '');

  const protectedBranches = new Set([...PROTECTED_BRANCHES, defaultBranch]);
  const claudeTreesRoot = join(sourceWorkspace, '.claude', 'worktrees');
  const managedRoots = [
    { path: WORKTREES_DIR, requireAgentId: true },
    { path: claudeTreesRoot, requireAgentId: false },
  ];

  // An unreadable inventory is not an empty successful sweep: callers must
  // retain work rather than falling through to receipt-free orphan cleanup.
  const worktrees = await listWorktrees(sourceWorkspace);
  const reaped = [];
  const skipped = [];

  for (const wt of worktrees) {
    // Never touch the primary worktree (the main repo checkout).
    if (pathsEqual(wt.path, sourceWorkspace)) continue;
    if (wt.bare || wt.detached || !wt.branch) { skipped.push({ path: wt.path, reason: 'no-branch' }); continue; }

    const branchName = wt.branch.replace(/^refs\/heads\//, '');
    if (!branchName) { skipped.push({ path: wt.path, reason: 'no-branch' }); continue; }
    // Named so a caller can say WHICH branch a hold kept, not just which path.
    const hold = (reason) => skipped.push({ path: wt.path, branch: branchName, reason });
    if (protectedBranches.has(branchName) || branchName === currentBranch) {
      hold('protected');
      continue;
    }

    const isClaudeTree = isPathInsideDir(claudeTreesRoot, wt.path);
    const ownershipReason = worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds: readActiveIds(),
      roots: managedRoots,
      requireKnownLiveness: true,
    });
    if (ownershipReason) { hold(ownershipReason); continue; }
    if (isClaudeTree && !includeClaudeTrees) { hold('claude-tree-excluded'); continue; }

    // Gate 1: working tree must be completely clean. Unlike removeWorktree(),
    // the background reaper does not discard even lockfile-only edits: an
    // uncommitted fresh-from-main worktree may be an active agent that has not
    // made its first commit yet.
    //
    // Only a proven-absent directory is empty. A prunable registration may
    // instead be an existing checkout with a broken .git pointer and unique work.
    const status = await readWorktreeStatus(wt.path);
    if (status === null) { hold('status-failed'); continue; }
    if (!classifyWorktreeDirt(status).clean) { hold('uncommitted'); continue; }

    // Gate 2: branch fully merged into the default branch (regular, squash, or rebase).
    const hasMergeEvidence = await hasBranchMergeEvidence(sourceWorkspace, branchName, target).catch(() => false);
    if (!hasMergeEvidence) { hold('unmerged'); continue; }

    // The early reconcile pass must see the SAME registered owners and branch
    // reservations as later retirement. Binding stays excluded until removal and
    // branch deletion settle — by the lock, and by the checkout fence while the
    // archive runs between the two critical sections (#12682).
    const verifyRemoval = async (holder) => {
      if (!holder || holder.branch !== wt.branch) return 'worktree-holder-changed';
      const agents = await readOwners();
      const ownerReason = claimCheckoutOwnerReason({ branchName, holderPath: wt.path, sourceWorkspace, agents });
      if (ownerReason) return ownerReason;
      const policyHold = await readBranchCompletionHold({ repoPath: sourceWorkspace, branch: branchName, tip: wt.head, retirement: true });
      if (policyHold) return policyHold;
      const reason = worktreeOwnershipReason({ path: wt.path, locked: holder.locked, activeAgentIds: readActiveIds(), roots: managedRoots, requireKnownLiveness: true });
      if (reason) return reason;
      const freshStatus = await readWorktreeStatus(wt.path);
      if (freshStatus === null) return 'worktree-status-unavailable';
      if (!classifyWorktreeDirt(freshStatus).clean) return 'worktree-dirty';
      return await hasBranchMergeEvidence(sourceWorkspace, branchName, target).catch(() => false) ? null : 'unmerged';
    };
    await retireWithUnlockedArchive({
      busy: () => hold('checkout-retirement-reserved'),
      admit: async () => {
        const initialHold = await verifyRemoval(wt);
        if (initialHold) { hold(initialHold); return {}; }
        return { fence: { repoPath: sourceWorkspace, path: wt.path, branch: branchName } };
      },
      archive: async () => {
        const hold = await verifyRemoval(wt);
        if (hold) {
          skipped.push({ path: wt.path, branch: branchName, reason: hold });
          return {};
        }
        return { archive: { verify: holder => verifyRemoval(holder) } };
      },
      finish: async (_admitted, preservation) => {
        const { readRetirementCheckoutIdentity } = await import('../lib/retirementCheckoutObservation.js');
        const checkoutIdentity = await readRetirementCheckoutIdentity(wt.path).catch(() => null);
        const removal = await forceRemoveWorktreeDir(sourceWorkspace, wt.path, {
          label: `worktree remove failed for ${wt.path}`,
          verifyRemoval: async holder => await verifyRemoval(holder) || await preservation.verify(holder),
        });
        if (!removal.removed) {
          skipped.push({ path: wt.path, branch: branchName, reason: removal.reason || 'remove-failed', warning: removal.warning });
          return;
        }
        const holders = removal.entries || await listWorktrees(sourceWorkspace).catch(() => null);
        const branchDeleted = holders && !holders.some(holder => holder.branch === wt.branch)
          && await deleteCompletedLocalBranch(sourceWorkspace, branchName, wt.head);
        if (branchDeleted && appId) {
          const { recordHeldCheckoutRetirement } = await import('./branchReconcileOutcome.js');
          const recorded = await recordHeldCheckoutRetirement(appId, {
            path: wt.path, branch: branchName, head: wt.head, branchDeleted: true,
            ...(checkoutIdentity && { checkoutIdentity }),
          }).then(outcome => outcome?.retired?.some(row => row.path === wt.path && row.branch === branchName
            && row.head === wt.head && row.branchDeleted === true && row.archiveDir == null
            && (!checkoutIdentity || row.checkoutIdentity === checkoutIdentity)) === true, () => false);
          if (!recorded) { hold('retirement-receipt-unverified'); return; }
        }
        reaped.push({ path: wt.path, branch: branchName, locked: !!wt.locked, branchDeleted: Boolean(branchDeleted) });
        if (!branchDeleted) hold('branch-ref-changed-or-new-holder');
      },
    });
  }

  if (reaped.length > 0) {
    console.log(`🌳 Reaped ${reaped.length} merged worktree(s): ${reaped.map(r => r.branch).join(', ')}`);
  }

  return { reaped, skipped, defaultBranch, target };
}

/**
 * Clean up worktree directories that belong to external repos (managed apps).
 * These are created when agents work on apps outside PortOS but use the shared
 * worktrees directory. They're invisible to PortOS's `git worktree list`.
 */
async function cleanupExternalRepoWorktrees(readActiveIds, alreadyHandled, readOwners, retainedPaths) {
  const { getDefaultBranch, hasBranchMergeEvidence } = await import('./git.js');
  const { retireWithUnlockedArchive } = await import('./cosClaimOwnershipState.js');
  const entries = await readdir(WORKTREES_DIR, { withFileTypes: true }).catch(() => []);
  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || alreadyHandled.has(entry.name)) continue;
    const worktreePath = join(WORKTREES_DIR, entry.name);
    const ownership = (extra = {}) => worktreeOwnershipReason({
      path: worktreePath,
      activeAgentIds: readActiveIds(),
      roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
      requireKnownLiveness: true,
      ...extra,
    });
    if (ownership()) continue;
    const gitFile = await lstat(join(worktreePath, '.git')).catch(() => null);
    if (!gitFile?.isFile()) continue;

    // Ask Git for its common directory and actual registration, rather than
    // inferring a parent from the spelling of a .git file. Relative pointers,
    // separate git directories and Windows separators are all valid.
    const commonDir = await execGit(['rev-parse', '--git-common-dir'], worktreePath)
      .then(r => r.stdout.trim() ? resolve(worktreePath, r.stdout.trim()) : null).catch(() => null);
    if (!commonDir) continue;
    // Git expands Windows short (8.3) aliases even where Node's realpath
    // keeps them. Compare Git's own spelling with its registration output.
    const gitWorktreePath = await execGit(['rev-parse', '--show-toplevel'], worktreePath)
      .then(r => r.stdout.trim()).catch(() => null);
    if (!gitWorktreePath || retainedPaths.has(gitWorktreePath)) continue;
    const registrations = await listWorktrees(worktreePath).catch(() => []);
    const wt = registrations.find(candidate => pathsEqual(candidate.path, gitWorktreePath));
    const primary = registrations[0];
    if (!wt || wt.bare || wt.detached || wt.prunable || !wt.branch) continue;
    if (!primary || primary.bare || pathsEqual(primary.path, gitWorktreePath)) continue;
    if (ownership({ locked: wt.locked })) continue;

    const parentRepo = primary.path;
    const parentCommonDir = await execGit(['rev-parse', '--git-common-dir'], parentRepo)
      .then(r => r.stdout.trim() ? resolve(parentRepo, r.stdout.trim()) : null).catch(() => null);
    if (!parentCommonDir || !pathsEqual(commonDir, parentCommonDir)) continue;

    const branchName = wt.branch.replace(/^refs\/heads\//, '');
    const defaultBranch = await getDefaultBranch(parentRepo, { strict: true }).catch(() => null);
    if (!defaultBranch || PROTECTED_BRANCHES.includes(branchName) || branchName === defaultBranch) continue;
    const status = await execGit(['status', '--porcelain'], worktreePath).then(r => r.stdout).catch(() => null);
    if (status === null || !classifyWorktreeDirt(status).clean) continue;
    const target = await resolveMergeTarget(parentRepo, defaultBranch);
    const merged = await hasBranchMergeEvidence(parentRepo, branchName, target).catch(() => false);
    if (!merged) continue;

    // Non-force removal is a final Git guard against newly dirty or locked
    // trees. A refusal must never fall through to recursive filesystem removal.
    // The archive runs between two ownership critical sections (#12748) with
    // this checkout fenced; both re-read liveness and the registry.
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    const removed = await withCheckoutPublication(parentRepo, () => retireWithUnlockedArchive({
      busy: () => false,
      admit: async () => {
        if (ownership({ locked: wt.locked })
          || claimCheckoutOwnerReason({ branchName, holderPath: worktreePath, sourceWorkspace: parentRepo, agents: await readOwners() })) return { result: false };
        return { fence: { repoPath: parentRepo, path: worktreePath, branch: branchName } };
      },
      archive: async () => {
        const { readRetirementCheckoutIdentity } = await import('../lib/retirementCheckoutObservation.js');
        const checkoutIdentity = await readRetirementCheckoutIdentity(worktreePath).catch(() => null);
        return {
          archive: {
            ...(checkoutIdentity && { checkoutIdentity }),
            verify: async (latest) => {
              if (!latest || latest.head !== wt.head || latest.branch !== wt.branch) return 'worktree-holder-changed';
              const status = await execGit(['status', '--porcelain'], worktreePath).then(r => r.stdout, () => null);
              if (status === null || !classifyWorktreeDirt(status).clean) return 'worktree-dirty';
              if (!await hasBranchMergeEvidence(parentRepo, wt.head, target).catch(() => false)) return 'unmerged';
              return null;
            },
          },
        };
      },
      finish: async (_admitted, preservation) => {
        const latest = (await listWorktrees(parentRepo)).find(holder => pathsEqual(holder.path, worktreePath));
        if (ownership({ locked: latest?.locked }) || await preservation.verify(latest)
          || claimCheckoutOwnerReason({ branchName, holderPath: worktreePath, sourceWorkspace: parentRepo, agents: await readOwners() })
          || !await hasBranchMergeEvidence(parentRepo, wt.head, target).catch(() => false)) return false;
        const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
        if (await readBranchCompletionHold({ repoPath: parentRepo, branch: branchName, retirement: true })) return false;
        const ok = await execGit(['worktree', 'remove', worktreePath], parentRepo).then(() => true).catch(err => {
          console.warn(`⚠️ Preserved external worktree ${entry.name}: ${err.message}`);
          return false;
        });
        const deleted = ok && await deleteCompletedLocalBranch(parentRepo, branchName, wt.head);
        if (ok && !deleted) {
          console.warn(`⚠️ External branch ${branchName} retained: head changed, new holder, or deletion refused`);
        }
        if (ok) {
          const { recordWorkspaceCheckoutRetirement } = await import('./branchReconcileOutcome.js');
          await recordWorkspaceCheckoutRetirement(parentRepo, {
            path: wt.path, branch: branchName, head: wt.head, branchDeleted: Boolean(deleted),
            ...(preservation?.checkoutIdentity && { checkoutIdentity: preservation.checkoutIdentity }),
          }).catch(error => { console.warn(`⚠️ External retirement receipt not recorded for ${entry.name}: ${error.message}`); });
        }
        return ok;
      },
    })).catch(err => {
      console.warn(`⚠️ Preserved external worktree ${entry.name}: ${err.message}`);
      return false;
    });
    if (removed) cleaned++;
  }

  return cleaned;
}
