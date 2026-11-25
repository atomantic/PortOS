/** Worktree removal and completed branch retirement. */

import { existsSync, realpathSync } from 'fs';
import { lstat, rm } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { DONE_SENTINEL_NAME, doneSentinelCandidateNames } from '../../lib/agent/agentSentinel.js';
import { execGit } from '../../lib/execGit.js';
import { rmGuarded } from '../../lib/fileUtils.js';
import { PROTECTED_BRANCHES } from '../../lib/gitArgs.js';
import { decideForceRemoval, decideWith } from '../branchRetirementDecision.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { WORKTREES_DIR, pathsEqual } from './paths.js';
import { WORKTREE_ADD_TIMEOUT_MS } from './gitErrors.js';
import { queueWorktreeCreate } from './mutationQueue.js';
import { classifyWorktreeDirt, listWorktrees } from './status.js';

// Cap the dirty paths named in a "worktree preserved" warning — the message ends
// up in a notification and on the agent card, and a broad sweep can dirty
// hundreds of files. Enough to identify the work, short enough to read.
const DIRT_PATHS_IN_WARNING = 5;

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
    const { getDefaultBranch } = await import('../git/status.js');
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
 * Finish removing a managed directory after Git has let go of it. The caller
 * must already have authority over its contents (an admitted removal or the
 * reserved path for a new claim). A Git marker of any kind keeps it intact.
 */
export async function removeUnregisteredWorktreeResidue(repo, worktreePath, { worktreesRoot = WORKTREES_DIR, beforeMutation } = {}) {
  if (!isAbsolute(worktreePath)) return false;
  const target = resolve(worktreePath);
  if (!pathsEqual(dirname(target), worktreesRoot)) return false;
  const isResidue = async () => {
    const canonicalTarget = canonicalPath(target);
    if (!pathsEqual(dirname(canonicalTarget), worktreesRoot)) return false;
    const entries = await listWorktrees(repo).catch(() => null);
    if (!entries?.length || entries.some(wt => canonicalPath(wt.path) === canonicalTarget)) return false;
    const directory = await lstat(target).catch(() => null);
    return directory?.isDirectory() && await lstat(join(target, '.git')).then(() => false, error => error.code === 'ENOENT');
  };
  if (!await isResidue()) return false;
  if (beforeMutation) {
    await beforeMutation();
    if (!await isResidue()) return false;
  }
  return await rmGuarded(target, { recursive: true, force: true, maxRetries: 3 }).then(() => true, () => false);
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
 * if Git refuses, preserve surviving checkouts and only prune an absent tree.
 * After Git drops a managed checkout's registration and marker, finish removing
 * any residue under the original admission.
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
 * @param {string} [opts.worktreesRoot] - managed root for residue cleanup.
 * @param {boolean} [opts.force=true] - allow Git to remove a dirty checkout.
 * Local content is not a hold here: callers retire only merged deliveries,
 * throwaway checkouts or a rolled-back add, whose ignored and uncommitted
 * bytes are disposable.
 * @returns {Promise<{removed: boolean, directory: string, registration: string, warning: string|null}>}
 *   `warning` is set exactly when `removed` is false.
 */
export async function forceRemoveWorktreeDir(repo, worktreePath, opts = {}) {
  return withGitMutationLifetime(() => forceRemoveWorktreeDirAdmitted(repo, worktreePath, opts))
    .catch(error => ({ removed: false, reason: error.message, warning: 'Checkout retained: repository reservation unavailable' }));
}

// Hold reasons that mean the cleanup could not even decide, rather than a gate declining.
const REMOVAL_FAULT_HOLDS = new Set(['worktree-ownership-unreadable', 'worktree-removal-refused']);

async function forceRemoveWorktreeDirAdmitted(repo, worktreePath, { label, log = 'remove', subject = worktreePath, verifyRemoval, beforeMutation, force = true, worktreesRoot } = {}) {
  const logAll = label && log === 'all';
  let lastFailure = null;
  let heldReason = null;
  const findHolder = entries => entries.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath)) || null;
  const listHolder = () => listWorktrees(repo).then(entries => ({ holder: findHolder(entries), entries }), () => null);
  const check = async () => {
    let listed;
    const decision = await decideWith(facts => decideForceRemoval({ guarded: Boolean(verifyRemoval), facts }), {
      listing: async () => { listed = await listHolder(); return listed; },
      // The callback can await I/O, so the decision re-reads Git's registration after it.
      guardReason: async facts => (await verifyRemoval(facts.listing.holder, facts.listing.entries).catch(() => 'worktree-ownership-unreadable')) || false,
      fresh: listHolder,
    });
    return { reason: decision.hold?.reason ?? null, holder: listed?.holder };
  };
  const admission = await check();
  heldReason = admission.reason;
  if (!heldReason) await beforeMutation?.();
  if (!heldReason) await execGit(['worktree', 'remove', worktreePath, ...(force ? ['--force'] : [])], repo, { timeout: WORKTREE_ADD_TIMEOUT_MS }).catch(async (err) => {
    lastFailure = errorExcerpt(err);
    if (label) console.log(`⚠️ ${label}: ${err.message}`);
    // The caller's guard may require a holder, so re-running it after Git drops
    // the registration would reject the very residue we were admitted to remove.
    if (admission.holder && await removeUnregisteredWorktreeResidue(repo, worktreePath, { worktreesRoot, beforeMutation })) return;
    heldReason = (await check()).reason;
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
 * Discard the auto-generated lockfile churn that `classifyWorktreeDirt` reported.
 * Untracked lockfiles are deleted (git cannot restore what it does not track);
 * tracked ones are restored from the index. Rejects if either step fails, so the
 * caller decides whether the tree is still safe to remove.
 */
export async function discardLockfileChanges(worktreePath, dirt) {
  const untracked = new Set(dirt.untrackedLockfilePaths);
  for (const path of untracked) {
    await rm(join(worktreePath, path), { force: true });
  }
  const tracked = dirt.lockfilePaths.filter(path => !untracked.has(path));
  if (tracked.length) await execGit(['checkout', '--', ...tracked], worktreePath);
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
export async function resolveMergeTarget(sourceWorkspace, defaultBranch) {
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
    const [{ getDefaultBranch }, { hasBranchMergeEvidence }] = await Promise.all([
      import('../git/status.js'), import('../git/branchEvidence.js'),
    ]);
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
    const { readBranchCompletionHold } = await import('../branchCompletionPolicy.js');
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
  const { readClaimOwnershipAgents } = await import('../cos/cosClaimOwnershipState.js');
  const ownershipHold = async () => claimCheckoutOwnerReason({
    branchName, holderPath: join(WORKTREES_DIR, agentId), sourceWorkspace,
    agents: await readClaimOwnershipAgents().catch(() => null), ignoreIds: [agentId],
  });
  return withGitMutationLifetime(() => removeWorktreeNow(agentId, sourceWorkspace, branchName, options, ownershipHold));
}

/**
 * Removes a worktree directory the CoS ledger does not track (a claim checkout):
 * no ownership lock, merge or inspection, only an optional branch delete.
 * `force` unlocks the worktree first and deletes the branch with `-D`.
 *
 * @param {string} repoPath - repository that registers the worktree
 * @param {string} worktreePath - checkout directory to remove
 * @param {{ branchName?: string, deleteBranch?: boolean, force?: boolean }} [directOptions]
 */
export async function removeWorktreeAtPath(repoPath, worktreePath, directOptions = {}) {
  const entries = await listWorktrees(repoPath).catch(() => []);
  const holder = worktreePath ? entries.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath)) || null : null;
  const resolvedBranch = holder?.branch ? holder.branch.replace(/^refs\/heads\//, '') : directOptions.branchName || null;
  if (directOptions.force && worktreePath) {
    await execGit(['worktree', 'unlock', worktreePath], repoPath, { ignoreExitCode: true }).catch(() => null);
  }
  const removal = worktreePath
    ? await forceRemoveWorktreeDir(repoPath, worktreePath, { label: `Direct worktree cleanup for ${worktreePath}` })
    : { removed: true };
  if (directOptions.deleteBranch && resolvedBranch && !PROTECTED_BRANCHES.includes(resolvedBranch)) {
    await execGit(['branch', directOptions.force ? '-D' : '-d', resolvedBranch], repoPath, { ignoreExitCode: true }).catch(() => null);
  }
  return {
    merged: false,
    removed: removal.removed !== false,
    cleanupIncomplete: removal.removed === false,
    uncommittedSaved: false,
    warnings: removal.warning ? [removal.warning] : [],
  };
}

/**
 * Runs cleanup as claim-ownership critical sections: one inspection, then one
 * section per mutation (lockfile discard, removal) that re-reads the owners,
 * observes the checkout and acts. Every bind/release/reserve queues behind that
 * lock on a short budget, so the merge-target fetch and the merged-PR forge read
 * run between sections (#12764). Agent registration and checkout content change
 * without the lock, so removal re-checks them at Git's mutation boundary.
 */
export async function removeWorktreeNow(agentId, sourceWorkspace, branchName, options, ownershipHold) {
  const { withClaimOwnershipLock } = await import('../cos/cosClaimOwnershipState.js');
  const worktreePath = join(WORKTREES_DIR, agentId);
  const warnings = [];
  let merged = false;
  let commitsAhead = 0;
  let mergeRefused = false;
  const held = reason => {
    warnings.push(`Worktree preserved — ${reason}`);
    return { merged, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings };
  };
  // Fetched between sections, only once a removal needs it, and reused by every
  // check under the lock: a branch merged into origin/<default> stays merged.
  const { getDefaultBranch } = await import('../git/status.js');
  let mergeTarget = null;
  const resolveTarget = async () => {
    if (mergeTarget || await detachedCheckout()) return;
    const base = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
    if (base) mergeTarget = await resolveMergeTarget(sourceWorkspace, base);
  };
  const completionHold = expectedHead => removalCompletionHold({ ownershipHold, sourceWorkspace, branchName, mergeTarget, expectedHead });
  // A follow-up on a branch the primary checkout owns runs DETACHED (createWorktree):
  // there is no branch to protect, merge or delete, so only its commits matter.
  // Probed lazily: every early refusal above the removal step is a pure-status exit.
  let detachedProbe = null;
  const detachedCheckout = () => detachedProbe ||= listWorktrees(sourceWorkspace)
    .then(trees => trees.find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath) && wt.detached && !wt.branch) || null, () => null);
  const detachedHold = head => removalDetachedHold({ ownershipHold, sourceWorkspace, head });
  const ignoredPaths = [DONE_SENTINEL_NAME, ...doneSentinelCandidateNames(agentId)];
  // Set once the forge reports the branch's PR merged at this commit: removal
  // skips the dirt check only while the observed head is still that commit.
  let deliveredHead = null;
  const observeCheckout = async () => {
    const detached = Boolean(await detachedCheckout());
    return observeWorktreeForRemoval({
      sourceWorkspace, worktreePath, branchName, options, ignoredPaths, deliveredHead, detached,
      checkHold: detached ? detachedHold : completionHold,
    });
  };
  // One mutation as a single critical section: owners first, then `admit` (which
  // may stop with a result), then the observation `finish` acts on.
  const retire = async ({ admit = async () => null, onObservationFailure, finish }) => {
    await resolveTarget();
    return withClaimOwnershipLock(async () => {
      const owner = await ownershipHold();
      if (owner) return held(owner);
      const stop = await admit();
      if (stop) return stop;
      const observed = await observeCheckout().catch(error => {
        warnings.push(`Worktree preserved — ${error.message}`);
        return null;
      });
      return observed ? finish(observed) : onObservationFailure();
    });
  };
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

  // The already-gone path deletes the branch inside the inspection section.
  if (!existsSync(worktreePath)) await resolveTarget();
  const inspected = await withClaimOwnershipLock(() => inspectWorktreeForRemoval({
    agentId, sourceWorkspace, worktreePath, branchName, options, warnings, ignoredPaths, ownershipHold, detachedCheckout, cleanupBranch, held,
  }));
  if (inspected.result) return inspected.result;

  if (inspected.dirty) {
    deliveredHead = await readDeliveredHead({ sourceWorkspace, branchName, detachedCheckout });
    if (!deliveredHead) {
      console.log(`⚠️ Preserving worktree for ${agentId} — uncommitted changes detected (${inspected.dirty}), aborting cleanup to avoid data loss`);
      warnings.push(`Worktree preserved — uncommitted changes detected in ${worktreePath}: ${inspected.dirty}`);
      return { merged: false, removed: false, uncommittedSaved: false, warnings };
    }
  }

  if (inspected.missing) {
    return retire({
      onObservationFailure: () => ({ merged: false, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings }),
      finish: async (observed) => {
        const gone = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, { verifyRemoval: observed.verify });
        if (!gone.removed) {
          warnings.push(gone.warning);
          return { merged: false, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings };
        }
        console.log(`🌳 Worktree already removed for ${agentId}, cleaning up branch`);
        await cleanupBranch(observed.head);
        return { merged: false, removed: true, uncommittedSaved: false, warnings };
      },
    });
  }

  if (inspected.lockfile) {
    const { dirt, dirtyFiles } = inspected.lockfile;
    // Discard only the lockfile churn inspected above; the removal section below
    // re-checks the tree it then removes.
    const discardFailure = await retire({
      onObservationFailure: () => ({ merged: false, removed: false, uncommittedSaved: false, warnings }),
      finish: () => discardAdmittedLockfileChurn({ agentId, worktreePath, dirt, dirtyFiles, warnings }),
    });
    if (discardFailure) return discardFailure;
  }

  return retire({
    admit: async () => {
      if (!options.merge || await detachedCheckout()) return null;
      const attempt = await mergeAgentBranchIntoDefault({ sourceWorkspace, branchName, warnings });
      ({ merged, commitsAhead, mergeRefused } = attempt);
      return attempt.stop;
    },
    onObservationFailure: () => ({ merged, removed: false, cleanupIncomplete: true, uncommittedSaved: false, warnings }),
    finish: observed => completeWorktreeRemoval({ agentId, sourceWorkspace, worktreePath, branchName, observed, warnings, merged, detachedCheckout, cleanupBranch }),
  });
}

/**
 * The inspection critical section of removeWorktreeNow (runs under the claim-ownership
 * lock). Resolves to `{ result }` (final outcome), `{ missing }` (directory gone, git
 * still registers it), `{ lockfile }` (lockfile-only churn to discard), `{ dirty }`
 * (real changes to preserve), or `{}` (ready for removal).
 */
async function inspectWorktreeForRemoval({ agentId, sourceWorkspace, worktreePath, branchName, options, warnings, ignoredPaths, ownershipHold, detachedCheckout, cleanupBranch, held }) {
  const { getDefaultBranch } = await import('../git/status.js');
  const defaultBranch = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
  const protectedReason = PROTECTED_BRANCHES.includes(branchName) || branchName === defaultBranch
    ? 'protected-branch' : !defaultBranch ? 'default-branch-unavailable' : null;
  if (protectedReason && !await detachedCheckout()) return { result: held(protectedReason) };
  const owner = await ownershipHold();
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
    return { dirty: `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` };
  }
  return {};
}

/**
 * Discards the lockfile churn the inspection admitted, after re-reading the tree it
 * inspected. Resolves null on success, else the preserved-worktree result.
 */
async function discardAdmittedLockfileChurn({ agentId, worktreePath, dirt, dirtyFiles, warnings }) {
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
}

/**
 * The optional local auto-merge of an agent branch into the default branch (runs in the
 * removal critical section, after the owners are re-read). `stop` is a final result when
 * the commit count cannot be trusted; otherwise null.
 *
 * @returns {Promise<{ stop: object|null, merged: boolean, commitsAhead: number, mergeRefused: boolean }>}
 */
async function mergeAgentBranchIntoDefault({ sourceWorkspace, branchName, warnings }) {
  let merged = false;
  let commitsAhead = 0;
  let mergeRefused = false;
  const currentBranch = (await execGit(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    sourceWorkspace
  )).stdout.trim();

  // Defense-in-depth: NEVER merge the agent branch into a non-default branch.
  // See shouldRefuseDefaultBranchMerge for the rationale.
  const { getDefaultBranch } = await import('../git/status.js');
  const defaultBranch = await getDefaultBranch(sourceWorkspace).catch(() => null);
  if (shouldRefuseDefaultBranchMerge(currentBranch, defaultBranch)) {
    console.log(`🌳 Refusing auto-merge of ${branchName} into '${currentBranch}' (default branch is '${defaultBranch || 'unknown'}'). Use \`gh pr merge\` for non-default targets.`);
    warnings.push(`Auto-merge skipped — source repo HEAD is on '${currentBranch}', not default '${defaultBranch || 'unknown'}'. Branch ${branchName} preserved for manual review.`);
    mergeRefused = true;
    return { stop: null, merged, commitsAhead, mergeRefused };
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
    return { stop: { merged: false, removed: false, uncommittedSaved: false, warnings }, merged, commitsAhead, mergeRefused };
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
  return { stop: null, merged, commitsAhead, mergeRefused };
}

/** Why a branch-backed checkout may not be removed right now, or null when it may be. */
async function removalCompletionHold({ ownershipHold, sourceWorkspace, branchName, mergeTarget, expectedHead }) {
  const owner = await ownershipHold();
  if (owner) return owner;
  const { readBranchCompletionHold } = await import('../branchCompletionPolicy.js');
  const policy = await readBranchCompletionHold({ repoPath: sourceWorkspace, branch: branchName, retirement: true });
  if (policy) return policy;
  const [{ getDefaultBranch }, { hasBranchMergeEvidence }] = await Promise.all([
    import('../git/status.js'), import('../git/branchEvidence.js'),
  ]);
  const defaultBranch = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
  if (!defaultBranch || !mergeTarget) return 'default-branch-unavailable';
  if (PROTECTED_BRANCHES.includes(branchName) || branchName === defaultBranch) return 'protected-branch';
  const head = (await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace).catch(() => null))?.stdout?.trim();
  if (!head || (expectedHead && head !== expectedHead)) return 'branch-head-changed-or-unavailable';
  return await hasBranchMergeEvidence(sourceWorkspace, head, mergeTarget).catch(() => false) ? null : 'merge-evidence-unavailable';
}

/** The detached-follow-up counterpart of removalCompletionHold: only unpublished commits matter. */
async function removalDetachedHold({ ownershipHold, sourceWorkspace, head }) {
  const owner = await ownershipHold();
  if (owner) return owner;
  const contained = await execGit(['branch', '-r', '--contains', head], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  return contained?.exitCode === 0 && contained.stdout.trim() ? null : 'detached-head-unpublished';
}

/**
 * A merged PR at this exact tip makes a dirty checkout disposable: its uncommitted and
 * untracked files go with it. Asked outside the lock (a forge call), and never for a
 * detached follow-up, which does not own its primary's branch. Resolves the delivered
 * tip, or null.
 */
async function readDeliveredHead({ sourceWorkspace, branchName, detachedCheckout }) {
  const { readMergedPrTip } = await import('../prProbe.js');
  const mergedTip = await readMergedPrTip(sourceWorkspace, branchName).catch(() => null);
  return mergedTip && !await detachedCheckout() ? mergedTip : null;
}

/**
 * Observe the checkout, refuse on a hold, and return the gate removal re-runs at Git's
 * mutation boundary (owners can register without the ownership lock). `deliveredHead`
 * skips the dirt check only while the observed head is still that commit.
 */
async function observeWorktreeForRemoval({ sourceWorkspace, worktreePath, branchName, options, ignoredPaths, deliveredHead, detached, checkHold }) {
  const tree = (await listWorktrees(sourceWorkspace)).find(wt => canonicalPath(wt.path) === canonicalPath(worktreePath));
  if (!tree || (detached ? !tree.detached || tree.branch : tree.branch !== `refs/heads/${branchName}`)) throw new Error('worktree-holder-changed');
  const hold = await checkHold(tree.head);
  if (hold) throw new Error(hold);
  return {
    head: tree.head, path: tree.path, branch: detached ? null : branchName,
    verify: async holder => {
      if (!holder || holder.head !== tree.head || Boolean(holder.detached) !== Boolean(tree.detached)) return 'worktree-holder-changed';
      if (!detached && holder.branch !== tree.branch) return 'worktree-holder-changed';
      const hold = await checkHold(tree.head);
      if (hold) return hold;
      if ((deliveredHead && tree.head.toLowerCase() === deliveredHead) || !existsSync(tree.path)) return null;
      const status = await execGit(['status', '--porcelain'], tree.path).then(r => r.stdout, () => null);
      if (status === null) return 'worktree-status-unavailable';
      const dirt = classifyWorktreeDirt(status, { ignoredPaths, preserveLockfiles: options.preserveLockfiles === true });
      if (!dirt.clean && !options.discardDirt) return 'worktree-dirty';
      return null;
    },
  };
}

/**
 * The final removal section's action: remove the checkout, delete its branch under the
 * same holds, and record the retirement receipt.
 */
async function completeWorktreeRemoval({ agentId, sourceWorkspace, worktreePath, branchName, observed, warnings, merged, detachedCheckout, cleanupBranch }) {
  const removal = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
    verifyRemoval: observed.verify,
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
  const branchCleaned = await detachedCheckout() || await cleanupBranch(observed.head);
  if (branchCleaned) console.log(`🌳 Removed worktree for ${agentId}${merged ? ' (merged)' : ''}`);
  const { recordWorkspaceCheckoutRetirement } = await import('../branchReconcileOutcome.js');
  // A completed cleanup attempt may retain a moved or newly held branch.
  const ref = observed.branch && await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${observed.branch}`],
    sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  await recordWorkspaceCheckoutRetirement(sourceWorkspace, {
    path: observed.path, branch: observed.branch, head: observed.head,
    branchDeleted: ref?.exitCode === 1,
    // A detached checkout has no branch to delete; its receipt says so instead of claiming one.
    ...(!observed.branch && { checkoutOnly: true }),
  }).catch(error => { warnings.push(`Retirement receipt not recorded: ${error.message}`); });
  return { merged, removed: true, uncommittedSaved: false, warnings };
}
