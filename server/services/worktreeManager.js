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

import { existsSync, realpathSync } from 'fs';
import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { ensureDir, isPathInsideDir, PATHS, sleep, tryReadFile } from '../lib/fileUtils.js';
import { DONE_SENTINEL_NAME, doneSentinelName } from '../lib/agentSentinel.js';
import { AGENT_SCRATCH_PATHS, matchesScratchRoot } from '../lib/agentScratchPaths.js';
import { execGit } from '../lib/execGit.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { enforceSafeBranchUpstream } from '../lib/branchUpstreamGuard.js';
import { forkRemoteName, normalizeForkHead } from '../lib/forkHead.js';
import { isHumanClaimWorktree, worktreeAgentId, worktreeOwnershipReason } from '../lib/worktreeOwnership.js';
import { ensureInstanceId } from './instances.js';

export { isHumanClaimWorktree } from '../lib/worktreeOwnership.js';

const WORKTREES_DIR = PATHS.worktrees;
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
// `worktree move` too — it routes through this same wrapper.
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60 * 1000;

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
export function addWorktreeWithRetry(args, repo, attempt = 1, firstError = null) {
  return execGit(args, repo, { timeout: WORKTREE_ADD_TIMEOUT_MS }).catch((err) => {
    const originalError = firstError || err;
    if (attempt >= WORKTREE_ADD_MAX_ATTEMPTS || !isGitLockError(err.message)) {
      err.firstAttemptError = originalError;
      throw err;
    }
    console.log(`🌳 Worktree ${args[1] || 'add'} lock contention (attempt ${attempt}/${WORKTREE_ADD_MAX_ATTEMPTS}), retrying in ${WORKTREE_ADD_RETRY_DELAY_MS}ms: ${err.message}`);
    return sleep(WORKTREE_ADD_RETRY_DELAY_MS)
      .then(() => addWorktreeWithRetry(args, repo, attempt + 1, originalError));
  });
}

// Per-source-repo serialization tail for worktree-creating git operations —
// the issueWriteTail pattern (see server/services/pipeline/issues.js). Git
// serializes its own worktree bookkeeping behind a per-repo lock, so two
// `git worktree add` calls in the same evaluation tick race and the loser is
// blocked with `blockedCategory: worktree-failed` (#2193). A single promise
// tail per repo collapses that race: each create awaits the previous one to
// settle before touching the shared `.git/worktrees` state. Keyed by
// realpath-resolved repo path so /var vs /private/var (macOS) don't split the
// tail into two lanes that can still collide.
const queueWorktreeCreateForKey = createKeyCachedQueue();
function queueWorktreeCreate(repo, fn) {
  let key = repo;
  try { key = realpathSync(repo); } catch { /* repo may not resolve — fall back to the raw path */ }
  if (!key) key = '__unknown__';
  return queueWorktreeCreateForKey(key, fn);
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

/**
 * Remove a worktree directory robustly: try `git worktree remove --force`, and
 * if git refuses (locked, already-gone, broken admin files), fall back to a
 * plain recursive `rm` + `git worktree prune` to clear git's stale bookkeeping.
 * Every step swallows its own error — cleanup is best-effort and must never
 * throw into a completion/reap path. Inlined verbatim in four call sites
 * before extraction (removeWorktree, removePersistentWorktree,
 * reapMergedWorktrees, cleanupExternalRepoWorktrees).
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
 *   facing signal); `'all'` also logs the rm + prune sub-failures. Ignored when
 *   `label` is absent (nothing logs). The two flags the four callers needed —
 *   "label + log everything" and "label + log remove only" and "silent" — are
 *   the three states here; there was never a "log without a label" caller.
 * @param {string} [opts.subject] - identifier embedded in the rm/prune
 *   sub-failure messages (only used when `log:'all'`). Defaults to
 *   `worktreePath`; the agent-cleanup callers pass their agent id so the
 *   message wording stays byte-identical to the pre-extraction logs an operator
 *   may grep for (e.g. `… for worktree <agentId>`).
 */
export async function forceRemoveWorktreeDir(repo, worktreePath, { label, log = 'remove', subject = worktreePath } = {}) {
  const logAll = label && log === 'all';
  await execGit(['worktree', 'remove', worktreePath, '--force'], repo).catch(async (err) => {
    if (label) console.log(`⚠️ ${label}: ${err.message}`);
    await rm(worktreePath, { recursive: true, force: true }).catch((rmErr) => {
      if (logAll) console.log(`⚠️ Manual rm failed for worktree ${subject}: ${rmErr.message}`);
    });
    await execGit(['worktree', 'prune'], repo).catch((pruneErr) => {
      if (logAll) console.log(`⚠️ Worktree prune failed for ${subject}: ${pruneErr.message}`);
    });
  });
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
async function enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch }) {
  return enforceSafeBranchUpstream(sourceWorkspace, branchName).catch(async (err) => {
    await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
      label: `Undoing worktree add for ${branchName} after an unsafe upstream`,
      log: 'all',
      subject: branchName,
    }).catch(() => {});
    if (deleteBranch) await cleanupOrphanBranch(sourceWorkspace, branchName, err);
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
 * @returns {{ clean: boolean, lockfileOnly: boolean, lockfilePaths: string[], realChangePaths: string[], hasRealChanges: boolean }}
 *   - clean: no changes at all
 *   - lockfileOnly: every change is an auto-generated lockfile (safe to discard)
 *   - lockfilePaths: paths of those lockfiles (strip the porcelain `XY ` status prefix)
 *   - realChangePaths: paths of the NON-lockfile changes, same prefix stripping.
 *     Branch reconciliation intersects these with what the default branch has
 *     touched since the branch diverged, to spot work that may have been
 *     superseded while it sat uncommitted.
 *   - hasRealChanges: at least one non-lockfile change (worktree must be preserved)
 */
export function classifyWorktreeDirt(porcelain, { ignoredPaths = [] } = {}) {
  const ignored = [...AGENT_SCRATCH_PATHS, ...ignoredPaths];
  const toPath = (line) => line.replace(/^\s*\S+\s+/, '').split(' -> ').pop();
  const lines = (porcelain || '').split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(line => !matchesScratchRoot(toPath(line), ignored));
  if (lines.length === 0) {
    return { clean: true, lockfileOnly: false, lockfilePaths: [], realChangePaths: [], hasRealChanges: false };
  }
  const isLockfile = (line) => AUTO_GENERATED_LOCKFILES.some(f => line.endsWith(f));
  // `R old -> new` (rename) names two paths; the post-rename path is the one
  // that exists on disk and the one a diff against the default branch reports.
  const lockfileLines = lines.filter(isLockfile);
  const lockfileOnly = lockfileLines.length === lines.length;
  return {
    clean: false,
    lockfileOnly,
    lockfilePaths: lockfileLines.map(toPath),
    realChangePaths: lines.filter((line) => !isLockfile(line)).map(toPath),
    hasRealChanges: !lockfileOnly
  };
}

/**
 * Compare two filesystem paths for equality, resolving symlinks (e.g. macOS
 * /var → /private/var) so normalization differences don't false-negative.
 */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const resolved = (p) => { try { return realpathSync(p); } catch { return p; } };
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
 * @returns {Promise<string|null>} the fork remote's name, or null
 */
async function ensureForkRemote(sourceWorkspace, forkHead, branchName) {
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

  await execGit(['fetch', remoteName, branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Fork fetch of ${remoteName}/${branchName} failed: ${err.message}`);
  });
  // Verify rather than trust the fetch's exit code: a fetch that reported
  // success but left no remote-tracking ref would otherwise send `worktree add`
  // at a start point git resolves somewhere else entirely.
  const refExists = await execGit(['rev-parse', '--verify', `${remoteName}/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  return refExists ? remoteName : null;
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
 * That branch is resolved local → `origin/<branch>` → `options.forkHead`. The third
 * step is what makes an EXTERNAL contribution reachable: a fork PR's head has no
 * `origin/<branch>` at all, so without it every "work on this PR's branch" path
 * failed at workspace prep for exactly the PRs external contributors open (#6064).
 *
 * @param {string} agentId - The agent identifier (used for branch/directory naming)
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} taskId - Task identifier (included in branch name for traceability)
 * @param {object} options - Optional configuration
 * @param {string} options.baseBranch - Branch to base the worktree on (auto-detected if omitted)
 * @param {string} options.existingBranch - Pre-existing branch to attach (creates from origin/<branch> if no local copy)
 * @param {{remoteUrl: string, ownerLogin: string}} options.forkHead - Where `existingBranch` lives when it is a FORK PR's head, which has no `origin/<branch>`. Consulted only after the local and origin lookups both miss; omitting it preserves today's exact behavior, error message included.
 * @param {string} options.planId - PLAN.md item slug ID — when provided, spliced into the branch name as `cos/<taskId>/<planId>/<agentId>` so other agents can detect this item is in flight by scanning branches/PRs
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
    const branchName = options.existingBranch;
    const localExists = (await execGit(['branch', '--list', branchName], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
    if (localExists) {
      await addWorktreeWithRetry(['worktree', 'add', worktreePath, branchName], sourceWorkspace);
    } else {
      // No local copy — we need a remote ref. If `git fetch` failed AND the
      // remote ref isn't available, fail loudly rather than emit a confusing
      // "couldn't find branch" git error.
      const remoteExists = await execGit(['rev-parse', '--verify', `origin/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
        .then((r) => r.exitCode === 0)
        .catch(() => false);
      // Third and last resolve step: a FORK PR's head lives in the contributor's
      // repository, so `origin/<branch>` legitimately does not exist. Reached
      // only when the caller supplied coordinates AND the two lookups above
      // missed, so a caller that passes no `forkHead` still gets the exact
      // error below rather than a new code path (#6064).
      const forkRemote = remoteExists ? null : await ensureForkRemote(sourceWorkspace, options.forkHead, branchName);
      if (!remoteExists && !forkRemote) {
        throw new Error(`Cannot attach worktree to ${branchName}: branch missing locally and origin/${branchName} unavailable${fetchSucceeded ? '' : ' (fetch failed)'}`);
      }
      // The start point decides the branch's upstream, and on the fork path that
      // is the whole point: tracking `<fork-remote>/<branch>` is what sends a
      // later `git push` to the CONTRIBUTOR's fork. Tracking origin here would
      // push their commits into the upstream repository instead — the #4172
      // failure mode, one remote over.
      const startPoint = forkRemote ? `${forkRemote}/${branchName}` : `origin/${branchName}`;
      // Use -B (force-create) so we don't fail if a stale local ref exists.
      // Attach path re-uses an existing branch, so no orphan-branch cleanup on failure.
      await addWorktreeWithRetry(['worktree', 'add', '-B', branchName, worktreePath, startPoint], sourceWorkspace);
      if (forkRemote) console.log(`🍴 Attached ${branchName} from fork remote ${forkRemote} (no origin/${branchName})`);
    }
    // Re-attaching a branch a PREVIOUS run created — which, before #4172, may
    // have been left tracking `refs/heads/main`. Repair it before the agent (and
    // its `/do:pr`) touches it. The guard's invariant is on the `merge` REF, not
    // on the remote, so `origin/<branchName>` and `<fork-remote>/<branchName>`
    // both pass untouched — which is required: dropping the fork upstream would
    // aim a config-derived push back at origin.
    await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch: false });
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
  const baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
    .then(() => `origin/${baseBranch}`)
    .catch(() => baseBranch);

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
 * @param {boolean} [options.allowLiveClaim=false] - treat a `claim-*` holder as
 *   adoptable rather than off-limits. The claim flow keeps no durable agent id
 *   for its branch, so this can't distinguish an idle claim tree from a live
 *   `/do:next` session in it — pass it only for a task whose whole purpose IS
 *   that exact branch (a review-loop resolve-and-merge follow-up, or a PR-
 *   remediation follow-up — `isNonCommittingCoordinatorTask` in taskTypeHooks.js),
 *   where the task's own deliverable is the signal that the claim's work should
 *   be finished and landed. Mirrors `branchReconcile.resolveLiveOwnerReason`'s
 *   dispatch-side carve-out for the same directory shape (#6243).
 * @returns {Promise<{ path: string, agentId: string }|null>}
 */
export async function findAdoptableWorktreeForBranch(sourceWorkspace, branchName, {
  activeAgentIds = new Set(),
  preferredPath = null,
  allowLiveClaim = false,
} = {}) {
  if (!sourceWorkspace || !branchName) return null;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
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
 * or one with initialized submodules). Callers fall back to a fresh worktree, which
 * is the pre-existing behavior.
 *
 * @param {string} agentId - the RETRYING agent (names the destination directory)
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} existingWorktreePath - absolute path of the dead agent's worktree
 * @param {string} branchName - the branch that worktree has checked out
 * @returns {Promise<{worktreePath: string, branchName: string, baseBranch: null, existingBranch: true, adopted: true, instanceId: string}|null>}
 */
export async function adoptWorktree(agentId, sourceWorkspace, existingWorktreePath, branchName) {
  return queueWorktreeCreate(sourceWorkspace, () => adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName));
}

async function adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName) {
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

  // Already at the destination (a retry that re-entered prep) — nothing to move.
  if (pathsEqual(existingWorktreePath, targetPath)) return adopted;

  if (existsSync(targetPath)) {
    console.log(`🌳 Cannot adopt worktree for ${agentId} — ${targetPath} is already occupied`);
    return null;
  }

  await ensureDir(WORKTREES_DIR);

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
  const dirt = classifyWorktreeDirt(porcelain);
  if (dirt.lockfileOnly) {
    console.log(`🧹 Discarding ${dirt.lockfilePaths.length} auto-generated lockfile change(s) in adopted worktree ${agentId}`);
    await execGit(['checkout', '--', ...dirt.lockfilePaths], targetPath).catch(err => {
      console.log(`⚠️ Lockfile discard failed in adopted worktree ${agentId}: ${err.message}`);
    });
  }

  console.log(`🌳 Adopted worktree for ${agentId} at ${targetPath} (branch: ${branchName}) — resuming interrupted work`);
  return adopted;
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
 * @param {boolean} [options.preserveBranchWithCommits] - keep the branch (rather
 *   than deleting it) whenever it still holds commits the default branch doesn't,
 *   so a retry can resume the work instead of restarting. Used by the FAILED-agent
 *   cleanup path; the PR path leaves it off so its local branch is still tidied up.
 * @param {boolean} [options.discardDirt] - remove even when the tree is dirty.
 *   The dirty-abort exists to protect work that might still be wanted; the
 *   throwaway-worktree posture has already declared this tree's contents
 *   worthless (its own prompt invites scratch edits and forbids committing), so
 *   for it the abort protects nothing and instead strands a full checkout per
 *   run, forever. ONLY the discard path may pass this.
 */
export async function removeWorktree(agentId, sourceWorkspace, branchName, options = {}) {
  const worktreePath = join(WORKTREES_DIR, agentId);
  const warnings = [];

  if (!existsSync(worktreePath)) {
    console.log(`🌳 Worktree already removed for ${agentId}, cleaning up branch`);
    await execGit(['branch', '-D', branchName], sourceWorkspace).catch(() => {});
    return { merged: false, removed: true, uncommittedSaved: false, warnings };
  }

  // Verify the worktree still points to the correct repo before trusting git status.
  // If the .git file is missing (e.g., worktree was partially cleaned up), git walks up
  // the directory tree and may find a parent repo (e.g., PortOS) instead of the app repo.
  // In that case, git status would report the parent repo's dirty files, causing us to
  // incorrectly preserve the worktree.
  const detectedToplevel = await execGit(['rev-parse', '--show-toplevel'], worktreePath)
    .then(r => r.stdout.trim())
    .catch(() => null);
  // Compare realpath-resolved forms so symlinks (e.g. macOS /var → /private/var)
  // or normalization differences don't false-positive as a broken worktree.
  if (detectedToplevel && !pathsEqual(detectedToplevel, worktreePath)) {
    console.log(`🌳 Worktree ${agentId} resolves to ${detectedToplevel} instead of ${worktreePath} — broken worktree, removing`);
    await rm(worktreePath, { recursive: true, force: true }).catch(rmErr => {
      console.log(`⚠️ Failed to remove broken worktree ${agentId}: ${rmErr.message}`);
    });
    await execGit(['branch', '-D', branchName], sourceWorkspace).catch(() => {});
    return { merged: false, removed: true, uncommittedSaved: false, warnings };
  }

  // Safety check: abort removal when uncommitted changes are detected.
  // Also fail closed if git status itself fails — treat unknown state as dirty.
  let dirtyFiles;
  try {
    dirtyFiles = (await execGit(['status', '--porcelain'], worktreePath)).stdout.trim();
  } catch (err) {
    console.log(`⚠️ git status failed for worktree ${agentId}, preserving to avoid data loss: ${err.message}`);
    warnings.push(`Worktree preserved — git status failed: ${err.message}`);
    return { merged: false, removed: false, uncommittedSaved: false, warnings };
  }
  // The completion sentinel is not authored work: it has already been consumed
  // by finalizeAgent before this cleanup runs. Ignore it for the preservation
  // decision, while still preserving the tree if any real change remains; the
  // eventual forced worktree removal discards it with the rest of the completed
  // checkout. Both names — THIS run's `.agent-done-<agentId>` and the legacy
  // shared one a pre-upgrade run may have left — and no other agent's.
  const dirt = classifyWorktreeDirt(dirtyFiles, {
    ignoredPaths: [DONE_SENTINEL_NAME, doneSentinelName(agentId)]
  });
  if (!dirt.clean && options.discardDirt) {
    // Throwaway posture: the caller has already established that nothing in this
    // tree is wanted. Log what is being dropped so a surprising loss is at least
    // traceable, then fall through to removal.
    const shown = dirt.realChangePaths.slice(0, DIRT_PATHS_IN_WARNING);
    if (shown.length) console.log(`🌳 Discarding uncommitted changes in throwaway worktree ${agentId}: ${shown.join(', ')}`);
  } else if (!dirt.clean) {
    // Discard auto-generated lockfile changes that agents don't intend to commit
    // (e.g., npm install resolving ^version to exact version in package-lock.json)
    if (dirt.lockfileOnly) {
      console.log(`🧹 Discarding ${dirt.lockfilePaths.length} auto-generated lockfile change(s) in worktree ${agentId}`);
      await execGit(['checkout', '--', ...dirt.lockfilePaths], worktreePath);
    } else {
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
      return { merged: false, removed: false, uncommittedSaved: false, warnings };
    }
  }

  let merged = false;
  let commitsAhead = 0;
  let mergeRefused = false;

  if (options.merge) {
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
    } else {
      commitsAhead = parseInt((await execGit(
        ['rev-list', '--count', `${currentBranch}..${branchName}`],
        sourceWorkspace
      ).catch(() => ({ stdout: '0' }))).stdout.trim(), 10) || 0;

      if (commitsAhead > 0) {
        await execGit(['merge', branchName, '--no-edit'], sourceWorkspace)
          .then(() => { merged = true; })
          .catch(async (err) => {
            console.log(`⚠️ Could not auto-merge ${branchName}: ${err.message}`);
            await execGit(['merge', '--abort'], sourceWorkspace).catch(() => {});
            warnings.push(`Auto-merge failed for branch ${branchName} — branch preserved for manual recovery`);
          });
      }
    }
  }

  await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
    label: `Worktree remove failed for ${agentId}, falling back to manual cleanup`,
    log: 'all',
    subject: agentId,
  });

  // Preserve branch when (a) merge was attempted, failed, and has unmerged commits,
  // OR (b) merge was refused because HEAD is on a non-default branch — the commits
  // are still there and the user / a follow-up task may want to integrate manually.
  let hasUnmergedCommits = options.merge && !merged && (commitsAhead > 0 || mergeRefused);
  // ...OR (c) the caller asked us to keep any branch that still holds commits
  // (`preserveBranchWithCommits`). The no-merge path — which is what a FAILED
  // agent's cleanup takes — otherwise deletes the branch unconditionally, taking
  // the agent's committed work with it. That is what forces a retry to restart
  // from scratch instead of resuming: measured on agent-d2ae0352 (2026-07-27),
  // reaped 30s after its PR merged, whose branch was deleted and whose task was
  // re-dispatched to a fresh agent. Opt-in rather than automatic so the PR flow
  // (which deletes the LOCAL branch after pushing — the remote branch is what the
  // PR points at) keeps cleaning up after itself.
  if (!hasUnmergedCommits && options.preserveBranchWithCommits && !merged) {
    const { getDefaultBranch, isBranchMergedInto } = await import('./git.js');
    const target = await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
    // `isBranchMergedInto` — NOT a bare `rev-list --count target..branch`. A branch
    // whose PR was REBASE- or SQUASH-merged has new SHAs, so rev-list still reports
    // it ahead and we would preserve an already-landed branch and point a retry at
    // it. PortOS merges with `--rebase` by default, so that is the COMMON shape of
    // the very incident this preservation exists for ("PR merged, then reaped").
    // isBranchMergedInto covers patch-equivalence (`git cherry`) and fails closed,
    // which is the polarity we want here too: unknown ⇒ keep the work.
    const alreadyMerged = await isBranchMergedInto(sourceWorkspace, branchName, target).catch(() => false);
    if (!alreadyMerged) {
      hasUnmergedCommits = true;
      console.log(`🌳 Preserving branch ${branchName} — not yet merged into ${target}, kept so a retry can resume from it`);
      warnings.push(`Branch ${branchName} preserved — it holds unmerged commits a retry can resume from`);
    } else {
      console.log(`🌳 Branch ${branchName} is already merged into ${target} — safe to delete`);
    }
  }
  if (hasUnmergedCommits) {
    console.log(`⚠️ Preserving worktree branch ${branchName} for manual/automated recovery`);
  } else {
    await execGit(['branch', '-D', branchName], sourceWorkspace)
      .catch(err => {
        console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
      });
  }

  console.log(`🌳 Removed worktree for ${agentId}${merged ? ' (merged)' : ''}`);

  return { merged, removed: true, uncommittedSaved: false, warnings };
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
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  if (!existsSync(worktreePath)) return { removed: false };

  await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
    label: `Persistent worktree remove failed for ${featureAgentId}, falling back`,
    log: 'all',
    subject: featureAgentId,
  });

  await execGit(['branch', '-D', branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
  });

  console.log(`🌳 Removed persistent worktree for feature agent ${featureAgentId}`);
  return { removed: true };
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
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // Same two spellings. Set when git considers the registration disposable —
      // its directory is gone, or its .git pointer no longer resolves.
      current.prunable = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

/**
 * Clean up any orphaned worktrees (worktrees whose agent no longer exists)
 *
 * @param {string} sourceWorkspace - The original git repository path
 * @param {Set<string>} activeAgentIds - Set of currently active agent IDs
 */
export async function cleanupOrphanedWorktrees(sourceWorkspace, activeAgentIds) {
  if (!existsSync(WORKTREES_DIR)) return 0;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
  let cleaned = 0;

  // Track which agent dirs we handle via git worktree list (PortOS-owned worktrees)
  const handledAgentIds = new Set();

  for (const wt of worktrees) {
    const ownershipReason = worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds,
      roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
      requireKnownLiveness: true,
    });
    if (ownershipReason === 'worktree-unmanaged-location') continue;
    const agentId = worktreeAgentId(wt.path);
    handledAgentIds.add(agentId);
    if (ownershipReason) continue;

    const branchName = wt.branch?.replace('refs/heads/', '') || '';
    // Attempt merge so committed work from preserved worktrees (e.g., PR/push failures) isn't lost.
    // If merge fails, the branch is preserved for manual recovery.
    const result = await removeWorktree(agentId, sourceWorkspace, branchName, { merge: true })
      .catch(err => {
        console.log(`⚠️ Failed to clean orphaned worktree ${agentId}: ${err.message}`);
        return { removed: false };
      });
    if (result?.removed) cleaned++;
  }

  // Scan for external-repo worktrees (directories whose .git points to a different repo).
  // These are invisible to `git worktree list` run against PortOS.
  cleaned += await cleanupExternalRepoWorktrees(activeAgentIds, handledAgentIds);

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
 *      `isBranchMergedInto`, which covers normal AND squash/rebase merges.
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
 * `includeUnmanagedTrees` drops the managed-root allowlist, so a worktree living
 * anywhere is eligible. It drops the two rules that allowlist carried — the
 * location check, and `WORKTREES_DIR`'s `requireAgentId` — and nothing else: the
 * lock, live-agent, unknown-liveness and human-claim holds all still apply, as do
 * both gates above (so a tree it reaches is still merged + clean before anything
 * is removed). It exists for the user-initiated "clean merged branches" action,
 * where the point IS to clear whatever worktree pins a merged branch; the
 * scheduled sweeps leave it off so an unattended pass never reaches outside the
 * directories PortOS created.
 *
 * @param {string} sourceWorkspace - repo root
 * @param {object} [options]
 * @param {Set<string>} [options.activeAgentIds] - CoS agents currently running (never reaped).
 *   Anything but a Set reads as "liveness unknown" and holds every `agent-*` tree.
 * @param {Set<string>} [options.excludeBranches] - branch names never reaped, whatever their tree
 * @param {boolean} [options.includeClaudeTrees=true] - also reap `.claude/worktrees/`
 * @param {boolean} [options.includeUnmanagedTrees=false] - consider worktrees outside the managed roots
 * @param {string} [options.defaultBranch] - skip the default-branch lookup, which can
 *   contact the remote (`remote set-head`); pass it on a latency-sensitive request path
 * @param {boolean} [options.dryRun=false] - report candidates without deleting
 * @returns {Promise<{reaped: Array<{path,branch,locked,branchDeleted}>, skipped: Array<{path,branch,reason}>, defaultBranch: string, target: string, dryRun: boolean}>}
 */
export async function reapMergedWorktrees(sourceWorkspace, {
  activeAgentIds = new Set(),
  excludeBranches = null,
  includeClaudeTrees = true,
  includeUnmanagedTrees = false,
  defaultBranch: knownDefaultBranch = null,
  dryRun = false
} = {}) {
  const { getDefaultBranch, isBranchMergedInto } = await import('./git.js');

  // Refresh remote refs so "merged into origin/main" reflects the canonical state
  // after a `gh pr merge`. Best-effort — fall back to local refs on failure.
  await execGit(['fetch', 'origin', '--prune'], sourceWorkspace, { ignoreExitCode: true }).catch(() => {});

  const defaultBranch = knownDefaultBranch || await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  // Prefer the remote-tracking ref (post-merge truth); fall back to the local branch.
  const remoteTarget = await execGit(['rev-parse', '--verify', `origin/${defaultBranch}^{commit}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? `origin/${defaultBranch}` : null))
    .catch(() => null);
  const target = remoteTarget || defaultBranch;

  const currentBranch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true })
    .then(r => r.stdout.trim())
    .catch(() => '');

  const protectedBranches = new Set(['main', 'master', 'dev', 'develop', 'release', defaultBranch]);
  const claudeTreesRoot = join(sourceWorkspace, '.claude', 'worktrees');
  // An empty allowlist is how worktreeOwnershipReason spells "no location check"
  // (see includeUnmanagedTrees above for what that gives up).
  const managedRoots = includeUnmanagedTrees ? [] : [
    { path: WORKTREES_DIR, requireAgentId: true },
    { path: claudeTreesRoot, requireAgentId: false },
  ];

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
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
    if (protectedBranches.has(branchName) || branchName === currentBranch || excludeBranches?.has(branchName)) {
      hold('protected');
      continue;
    }

    const isClaudeTree = isPathInsideDir(claudeTreesRoot, wt.path);
    const ownershipReason = worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds,
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
    // A registration git already calls prunable has no working tree left to be
    // dirty, so it reads as clean rather than status-failed — otherwise `git
    // status` fails in the missing directory and the branch stays pinned behind a
    // worktree that no longer exists. `existsSync` covers the same state on a git
    // too old to report `prunable` in `worktree list --porcelain`.
    const status = wt.prunable || !existsSync(wt.path)
      ? ''
      : await execGit(['status', '--porcelain'], wt.path).then(r => r.stdout).catch(() => null);
    if (status === null) { hold('status-failed'); continue; }
    if (!classifyWorktreeDirt(status).clean) { hold('uncommitted'); continue; }

    // Gate 2: branch fully merged into the default branch (regular, squash, or rebase).
    const merged = await isBranchMergedInto(sourceWorkspace, branchName, target).catch(() => false);
    if (!merged) { hold('unmerged'); continue; }

    if (dryRun) { reaped.push({ path: wt.path, branch: branchName, locked: !!wt.locked, branchDeleted: false }); continue; }

    // Remove the worktree, then force-delete the branch (-D because squash-merged
    // branches aren't recognized by -d, and we've proven the work is in default).
    await forceRemoveWorktreeDir(sourceWorkspace, wt.path, {
      label: `worktree remove failed for ${wt.path}, manual cleanup`,
    });
    // Reported per entry: the tree is gone either way, but a caller that
    // presents this as "branch deleted" would otherwise be lying on a failure.
    const branchDeleted = await execGit(['branch', '-D', branchName], sourceWorkspace).then(() => true).catch(err => {
      console.log(`⚠️ branch delete failed for ${branchName}: ${err.message}`);
      return false;
    });
    reaped.push({ path: wt.path, branch: branchName, locked: !!wt.locked, branchDeleted });
  }

  if (reaped.length > 0) {
    console.log(`🌳 ${dryRun ? 'Would reap' : 'Reaped'} ${reaped.length} merged worktree(s): ${reaped.map(r => r.branch).join(', ')}`);
  }

  return { reaped, skipped, defaultBranch, target, dryRun };
}

/**
 * Clean up worktree directories that belong to external repos (managed apps).
 * These are created when agents work on apps outside PortOS but use the shared
 * worktrees directory. They're invisible to PortOS's `git worktree list`.
 */
async function cleanupExternalRepoWorktrees(activeAgentIds, alreadyHandled) {
  const entries = await readdir(WORKTREES_DIR, { withFileTypes: true }).catch(() => []);
  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    if (alreadyHandled.has(agentId) || activeAgentIds.has(agentId)) continue;
    // Human-driven `/claim` worktrees are not CoS agents — never reap them.
    if (isHumanClaimWorktree(agentId)) continue;

    const worktreePath = join(WORKTREES_DIR, agentId);
    const gitFile = join(worktreePath, '.git');

    // Read .git file to find the parent repo
    // In a worktree, .git is a file containing "gitdir: ..."; in a normal repo it's a directory
    const gitStat = await stat(gitFile).catch(() => null);
    if (gitStat?.isDirectory()) {
      // This is a normal git repo, not a worktree — skip to avoid accidental data loss
      continue;
    }
    const gitContent = gitStat ? await tryReadFile(gitFile) : null;
    if (!gitContent?.startsWith('gitdir:')) {
      // No .git file or unreadable — skip rather than removing potentially valuable data
      console.log(`🌳 Skipping worktree directory ${agentId} — cannot determine parent repo`);
      continue;
    }

    // Extract the parent repo from the gitdir path (e.g., /path/to/repo/.git/worktrees/agent-xxx)
    const gitdir = gitContent.replace('gitdir:', '').trim();
    const parentRepoGitDir = gitdir.replace(/\/worktrees\/[^/]+$/, '');
    const parentRepo = parentRepoGitDir.replace(/\/\.git$/, '');

    if (!existsSync(parentRepo)) {
      // Parent repo no longer exists — just remove directory
      console.log(`🌳 Removing orphaned external worktree ${agentId} (parent repo gone: ${parentRepo})`);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      cleaned++;
      continue;
    }

    // Clean via the parent repo's git
    console.log(`🌳 Cleaning external worktree ${agentId} from ${parentRepo}`);
    const branchName = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
      .then(r => r.stdout.trim())
      .catch(() => '');

    await forceRemoveWorktreeDir(parentRepo, worktreePath);

    if (branchName) {
      await execGit(['branch', '-D', branchName], parentRepo).catch(() => {});
    }
    cleaned++;
  }

  return cleaned;
}
