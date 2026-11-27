/**
 * Resolves and records the Git branch or checkout a task can safely resume.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { emitLog } from '../cos/cosEvents.js';
import { updateTask } from '../cos/cosTaskStore.js';
import { getAgents } from '../cos/cosAgentLifecycle.js';
import { getBranch, getBranchComparison, getDefaultBranch, getStatusPorcelain } from '../git/status.js';
import { getWorktreeBranches } from '../git/cleanup.js';
import { hasBranchMergeEvidence } from '../git/branchEvidence.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { claimContinuationPointer } from '../../lib/claimContinuation.js';
import { isTruthyMeta } from './agentState.js';
import { PATHS } from '../../lib/fileUtils.js';
import { resolveTaskTargetBranch, shouldStripTaskTargetBranch } from '../../lib/taskTargetBranch.js';

export const lockfileDeliverable = (task) => (resolveTaskHookType(task) === 'dependency-updates' ? { preserveLockfiles: true } : {});

/**
 * What, if anything, should a retry of this task pick up from the run that just
 * died? Called after cleanup has decided what to preserve, so the answer reflects
 * what's actually on disk rather than what we hoped.
 *
 * Two shapes of leftover work, in priority order:
 *
 *   1. **Adopt the worktree** — `{ branchName, worktreePath }`. The dead agent's
 *      own worktree survived cleanup (a dirty tree aborts removal) and is still on
 *      its branch. This is the shape a server restart leaves behind: the run is
 *      killed mid-edit, so its work is UNCOMMITTED and no branch pointer can carry
 *      it. The retry moves that tree to its own directory (see `adoptWorktree`).
 *   2. **Attach the branch** — `{ branchName, worktreePath: null }`. The worktree
 *      is gone but the branch survived with unmerged commits, so a fresh worktree
 *      attaches to it via `createWorktree`'s `existingBranch` path.
 *
 * Returns null when there is nothing to resume — no branch, no leftover work, or
 * a branch whose commits already landed. A null answer means "start clean", the
 * correct behavior for an agent that died before producing anything.
 *
 * Deliberately checks the LOCAL branch: `removeWorktree` preserves it in place,
 * and `createWorktree`'s `existingBranch` path prefers a local copy before
 * falling back to `origin/<branch>`, so a local-only branch resumes fine.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} branchName - the dead agent's worktree branch
 * @param {string} [worktreePath] - the dead agent's worktree directory, the
 *   adoption candidate. Omit to consider only the branch-attach shape.
 * @returns {Promise<{branchName: string, worktreePath: string|null}|null>}
 */
export async function resolveResumePointer(sourceWorkspace, branchName, worktreePath = null, { preserveLockfiles = false } = {}) {
  if (!sourceWorkspace || !branchName) return null;

  const survivingTree = !!(worktreePath && existsSync(worktreePath));
  const target = await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  // Same predicate `removeWorktree` used to decide whether to KEEP this branch, so
  // the two can't disagree and orphan it. `hasBranchMergeEvidence` (not a rev-list
  // count) because a rebase/squash-merged branch has new SHAs and would otherwise
  // read as resumable — pointing a retry at already-landed work. Note the polarity
  // flips only for a rejected call: resume starts clean on rejection, while the
  // predicate's internal probe failures still return false. The existence checks
  // below keep that negative evidence result from reviving an absent branch.
  const hasMergeEvidence = await hasBranchMergeEvidence(sourceWorkspace, branchName, target).catch(() => true);
  // Nothing survived and nothing is unmerged — the common "run finished, branch
  // landed, tree already reaped" shape. Bail before spending any more git calls.
  if (hasMergeEvidence && !survivingTree) return null;

  // How many commits the branch holds that the default branch doesn't. Only ever
  // consulted on one of the two mutually exclusive paths below, so it costs a
  // single call per resolution.
  const commitsAhead = async () =>
    (await getBranchComparison(sourceWorkspace, target, branchName).catch(() => null))?.ahead || 0;

  // 1. Adopt the surviving tree — but only if it is actually on the branch we're
  //    resuming; a half-cleaned or repurposed directory must not be handed over.
  if (survivingTree && await getBranch(worktreePath).catch(() => null) === branchName) {
    if (!hasMergeEvidence) {
      emitLog('info', `🌳 Worktree ${worktreePath} survived on ${branchName} without established merge evidence — a retry can adopt it`, { branchName, worktreePath });
      return { branchName, worktreePath };
    }
    // A merged branch reads that way for two very different reasons. Commits that
    // already LANDED (ahead > 0) must never be resumed onto — that's the
    // prior recovery incident. A branch that never committed at all (ahead === 0)
    // has nothing to duplicate, so an uncommitted tree on top of it is safe to
    // adopt — and that is exactly the restart case this function exists for:
    // killed mid-edit, zero commits, hours of uncommitted work.
    if (await commitsAhead() > 0) return null;
    // Same dirt classifier `removeWorktree` uses, so "worth preserving" and "worth
    // resuming" can't disagree: lockfile churn an agent never meant to commit is
    // not work, and a tree holding only that should start clean.
    const porcelain = await getStatusPorcelain(worktreePath).catch(() => '');
    const { classifyWorktreeDirt } = await import('../worktreeManager.js');
    if (!classifyWorktreeDirt(porcelain, { preserveLockfiles }).hasRealChanges) return null;
    emitLog('info', `🌳 Worktree ${worktreePath} survived on ${branchName} — a retry can adopt it and keep its uncommitted work`, { branchName, worktreePath });
    return { branchName, worktreePath };
  }

  if (hasMergeEvidence) return null;

  // 2. Attach a fresh worktree to the branch. Git allows a branch to be checked out
  //    in only ONE worktree, so if a worktree is STILL on this branch, `git worktree
  //    add <path> <branch>` fails with "already checked out" and the retry can't
  //    spawn at all — worse than restarting clean. The adoption path above already
  //    handled the dead agent's OWN worktree; anything else holding the branch is
  //    not ours to move.
  const claimed = await getWorktreeBranches(sourceWorkspace).catch(() => null);
  if (claimed?.has(branchName)) {
    emitLog('info', `🌳 Branch ${branchName} is still checked out in a preserved worktree — a retry can't attach to it, so it will start clean`, { branchName });
    return null;
  }
  // Confirm the branch actually exists and holds commits — `hasBranchMergeEvidence`
  // returns false for an absent branch, which would hand back a branch name no
  // worktree can attach to.
  return await commitsAhead() > 0 ? { branchName, worktreePath: null } : null;
}

/**
 * A claim-flow relaunch continues the `claim-*` worktree the paused run already
 * cut for its pinned target. Resolved before the CoS-worktree bail: claim agents
 * record `isWorktree: false` because PortOS did not provision the directory, and
 * that bail is what used to requeue the relaunch onto a clean checkout.
 *
 * Fails closed (null → the caller keeps the ordinary "start clean" answer) when
 * the agent list cannot be read. An empty list would look like "nobody is in
 * that tree."
 */
async function resolveClaimContinuationPatch({ task, agentId, agentMetadata }) {
  const source = agentMetadata?.sourceWorkspace || agentMetadata?.workspacePath;
  if (!source) return null;
  const agents = await getAgents().catch(() => null);
  if (!agents) return null;
  const { listWorktrees } = await import('../worktreeManager.js');
  const worktrees = await listWorktrees(source).catch(() => []);
  const pointer = claimContinuationPointer({
    task, agentId, worktrees, agents, worktreesRoot: PATHS.worktrees, sourceWorkspace: source,
  });
  if (!pointer) return null;
  emitLog('info', `🔁 Task ${task.id} will resume in the claim worktree ${pointer.resumeWorktreePath} (${pointer.existingBranch}) instead of starting clean`, {
    taskId: task.id, agentId, branchName: pointer.existingBranch, worktreePath: pointer.resumeWorktreePath,
  });
  return pointer;
}

/**
 * The task-metadata patch that points a retry of `task` at what the run that just
 * died left behind — or clears a spent pointer, or does nothing. Resolves only;
 * `recordTaskResumePointer` persists it, `handleOrphanedTask` folds it into its own
 * retry write. Three outcomes, and the difference between the last two matters:
 *   - a **set** patch — there is leftover work; point the retry at it
 *   - a **clear** patch — this task WAS resuming, we looked, and there is nothing
 *     left (the branch merged or vanished); drop the pointer so the next attempt
 *     doesn't attach to it
 *   - an **empty** patch — nothing to say; leave whatever the task already carries
 *
 * Every path that retires a dead run funnels through here so the "can this be
 * resumed?" question has one answer:
 *   - `handleAgentCompletion` (agentCompletionCleanup.js) — the agent failed and
 *     its completion hook ran normally.
 *   - `handleOrphanedTask` (agentManagement.js) — the agent's process vanished
 *     (server restart / crash), so no completion hook ever ran. That path is why
 *     this is shared: a restart-killed run was requeued with no pointer at all,
 *     and its replacement redid work that was already sitting on disk.
 *
 * @param {{task: object, agentId: string, agentMetadata: object}} params
 * @returns {Promise<object>} metadata patch to merge into an `updateTask` call
 */
export async function resolveTaskResumePatch({ task, agentId, agentMetadata }) {
  if (!task?.id || !agentId) return {};
  if (isTruthyMeta(task.metadata?.discardWorktree)) return {};
  // Release retries reserve a fresh candidate after Git/GitHub pre-flight.
  // Published inline synchronization retains its separate continuation path.
  if (agentMetadata?.taskAnalysisType === 'do-release' && agentMetadata.isWorktree === false) {
    return agentMetadata.releasePublication?.synchronizationHandoffVersion === 2 ? { resumedFromAgentId: agentId } : {};
  }
  const claimContinuation = await resolveClaimContinuationPatch({ task, agentId, agentMetadata });
  if (claimContinuation) return claimContinuation;
  // Persistent feature-agent worktrees are never torn down, and throwaway
  // reasoning worktrees are deliberately discarded — neither leaves work to resume.
  // These runs are NOT evaluated at all, which is why they return the empty patch
  // rather than the clear: a task already resuming whose retry couldn't get a
  // worktree (see agentWorkspacePrep's degrade path) must KEEP its pointer, since
  // the tree it names is still sitting there for the attempt after this one.
  if (!agentMetadata?.isWorktree || agentMetadata?.isPersistentWorktree) return {};

  // The agent's own recorded path is authoritative; the `<worktrees>/<agentId>`
  // convention is the fallback for a record written before it was stamped (same
  // idiom cleanupAgentWorktree uses for the PR push).
  const worktreePath = agentMetadata.workspacePath || join(PATHS.worktrees, agentId);
  const pointer = await resolveResumePointer(agentMetadata.sourceWorkspace, agentMetadata.worktreeBranch, worktreePath, lockfileDeliverable(task))
    .catch(err => {
      emitLog('warn', `Failed to resolve resume pointer for ${agentId}: ${err.message}`, { agentId });
      return null;
    });

  if (pointer) {
    emitLog('info', `🔁 Task ${task.id} will resume ${pointer.worktreePath ? `in the worktree ${agentId} left behind` : `from ${pointer.branchName}`} instead of restarting`, {
      taskId: task.id, agentId, branchName: pointer.branchName, worktreePath: pointer.worktreePath
    });
  }
  return resumePointerMetadata(pointer, agentId, task);
}

/**
 * The task-metadata patch that makes a retry resume (or stop resuming).
 *
 * `existingBranch` is the retry-owned target that `agentWorkspacePrep` resolves
 * before attaching a worktree, and `resumeWorktreePath` is honored there too, so
 * resuming needs no new spawn plumbing. `resumedFromAgentId` records whose run is
 * being continued — it drives the prompt's resume banner and is the marker that
 * distinguishes a resume from a review-loop follow-up (see `isPrBranchWorktree`
 * in agentPromptBuilder.js).
 *
 * With no pointer, a previously-stamped resume is CLEARED: its branch may since
 * have been merged or deleted, and leaving the pointer would attach the next
 * attempt to landed work. Keyed on `resumedFromAgentId` so it only ever clears a
 * pointer this mechanism wrote. Review-loop follow-ups keep their canonical target
 * in `reviewLoopPRBranch`, so clearing a legacy duplicate cannot strand the PR.
 *
 * @param {{branchName: string, worktreePath: string|null}|null} pointer
 * @param {string} agentId - the run being resumed from
 * @param {object} task - the task being retried (read for a prior pointer)
 * @returns {object} metadata patch to merge into an `updateTask` call
 */
export function resumePointerMetadata(pointer, agentId, task) {
  if (pointer) {
    return {
      existingBranch: pointer.branchName,
      resumedFromAgentId: agentId,
      resumeWorktreePath: pointer.worktreePath
    };
  }
  if (!shouldStripTaskTargetBranch(task?.metadata)) return {};
  // `undefined`, not `null`: `updateTask` DELETES undefined keys from the merged
  // metadata, while a null is stored as a present value (and older installs read
  // it back as the string `"null"`, a truthy `existingBranch` that sends the next
  // attempt looking for a branch named "null"). The keys are still
  // present on the returned patch, so callers can tell a clear from a no-op.
  return {
    existingBranch: undefined,
    resumedFromAgentId: undefined,
    resumeWorktreePath: undefined,
    claimResumeInPlace: undefined,
  };
}

/**
 * Resolve AND persist the resume patch. For callers that aren't already writing the
 * task; `handleOrphanedTask` folds the patch into its own retry write instead, so
 * the pointer can't land after the status flip that makes the task spawnable.
 *
 * @param {{task: object, agentId: string, agentMetadata: object}} params
 * @returns {Promise<object>} the patch that was written (empty when nothing was)
 */
export async function recordTaskResumePointer({ task, agentId, agentMetadata }) {
  const metadata = await resolveTaskResumePatch({ task, agentId, agentMetadata });
  if (Object.keys(metadata).length === 0) return metadata;

  await updateTask(task.id, { metadata }, task.taskType || 'user').catch(err => {
    emitLog('warn', `Failed to record resume pointer for task ${task.id}: ${err.message}`, { taskId: task.id, agentId });
  });
  if (!resolveTaskTargetBranch(metadata)) {
    emitLog('info', `🧹 Cleared spent resume pointer on task ${task.id} — nothing left to resume`, { taskId: task.id, agentId });
  }
  return metadata;
}

// A verification continuation deliberately retains even an already-merged
// branch. Ordinary failed-task retry correctly discards those resume pointers.
export async function runtimeResumePatch({ task, agentId, agentMetadata }) {
  const claim = await resolveClaimContinuationPatch({ task, agentId, agentMetadata });
  if (claim) return claim;
  if (hasClaimFlowContract(task)) throw new Error('Runtime verification claim checkout identity is unavailable; retain the prerequisite');
  if (!agentMetadata?.isWorktree || agentMetadata.isPersistentWorktree) return {};
  const branch = agentMetadata.worktreeBranch;
  const path = agentMetadata.workspacePath || join(PATHS.worktrees, agentId);
  if (!branch || !existsSync(path) || await getBranch(path) !== branch) {
    throw new Error('Runtime verification checkout identity is unavailable; retain the prerequisite');
  }
  return { existingBranch: branch, resumeWorktreePath: path, resumedFromAgentId: agentId };
}
