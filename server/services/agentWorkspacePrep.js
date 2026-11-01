import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
/**
 * Agent Workspace Preparation
 *
 * Resolves the working directory an agent runs in and provisions any
 * isolation it needs before the agent is registered/spawned. Extracted from
 * `spawnAgentForTask` in agentLifecycle.js so that orchestrator stays
 * readable — this owns: workspace-path resolution, the pre-task git pull
 * (with conflict deferral), optional JIRA ticket + feature branch creation,
 * persistent feature-agent worktrees, and explicit/auto-detected worktree
 * creation.
 *
 * Side effects that don't touch spawn-local state (creating a conflict task,
 * flipping the task to pending/blocked, creating worktrees, recording JIRA
 * fields on `task.metadata`) happen inline. Outcomes that the caller
 * must finish are returned as a discriminated result so the caller can fire
 * `cleanupOnError` + the matching `agent:deferred` / `agent:error` event:
 *
 *   { outcome: 'ready', workspacePath, resolvedApp, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree }
 *   { outcome: 'deferred', reason, deferReason, branch }   // git conflict — task paused on a `git-conflict-wait` cooldown
 *   { outcome: 'blocked', reason }                          // explicit worktree requested but creation failed
 *                                                           // (`worktree-busy` blocks are a TIMED pause and revive themselves)
 *
 * An unexpected throw bubbles to the caller's widened try/catch the same way
 * the inline code did.
 */

import { basename, join, resolve } from 'path';
import { existsSync } from 'fs';
import { execGit } from '../lib/execGit.js';
import { emitLog } from './cosEvents.js';
import { updateTask, addTask } from './cosTaskStore.js';
import { getAppById } from './apps.js';
import { isTruthyMeta, isFalsyMeta, protectedAgentIds } from './agentState.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import * as git from './git.js';
import { detectConflicts } from './taskConflict.js';
import { PINNED_HEAD_MOVED, createWorktree, adoptWorktree, findAdoptableWorktreeForBranch, isBranchCheckedOutElsewhereError, listWorktrees, releaseIdleSiblingNextHolder, releaseOwnerlessForeignHolder, unlinkWorktreeDependencies } from './worktreeManager.js';
import { resolveSpawnCwd, usesCreativeDirectorScratchCwd, creativeDirectorScratchCwd } from '../lib/spawnCwd.js';
import { enforceSafeBranchUpstream } from '../lib/branchUpstreamGuard.js';
import { resolveTaskTargetBranch, resolveTaskRemoteBranch } from '../lib/taskTargetBranch.js';
import { resolveTaskForkHead } from '../lib/forkHead.js';
import { getAppWorkspace, getAppDataForTask } from './agentAppWorkspace.js';
import { createJiraTicketForTask } from './promptSections/appContext.js';
import { INVESTIGATION_TASK_DELIVERY, isInvestigationTask } from '../lib/investigationTasks.js';
import { isNonCommittingCoordinatorTask, resolveTaskHookType } from './taskTypeHooks.js';
import { prHeldForOperator, resolvePrCompletion } from '../lib/prDisposition.js';
import { claimBranchAdmission, claimContinuationAdmission, claimContinuationWorkspace } from '../lib/claimContinuation.js';

const ROOT_DIR = PATHS.root;

/**
 * Park a task this module refuses to spawn, so the refusal is durable and
 * visible rather than a log line the scheduler reprints every tick.
 *
 * An un-persisted `blocked` outcome leaves the task `pending`: it is
 * re-dequeued, re-prepped and re-rejected forever, and the thing that would fix
 * it ("set the Repository Path in Apps") is only reachable from that task's own
 * log. Blocking puts it in the Blocked list carrying the instruction and leaves
 * it revivable once the config is fixed. Best-effort — the caller's block
 * outcome must stand even if the write fails.
 */
async function blockTask(task, reason, blockedCategory, extraMetadata = {}) {
  await updateTask(task.id, {
    status: 'blocked',
    metadata: {
      ...task.metadata,
      blockedReason: reason,
      blockedCategory,
      blockedAt: new Date().toISOString(),
      ...extraMetadata,
    },
  }, task.taskType || 'user').catch(() => {});
}

// How long a task waits for another worktree to release the branch it needs, and
// how many times it may wait. The producer of that contention is a cleanup
// tearing down the previous agent's worktree, which finishes in seconds — but a
// worktree `removeWorktree` REFUSED to delete (uncommitted changes) holds the
// branch until a human clears it, so the wait has to be bounded. Past the cap the
// task takes the ordinary `worktree-failed` block and the orphaned-PR notifier
// raises its card.
const WORKTREE_BUSY_COOLDOWN_MS = 2 * 60 * 1000;
// How long a task blocked by an unpullable shared checkout waits before retrying.
const GIT_CONFLICT_COOLDOWN_MS = 5 * 60 * 1000;
const WORKTREE_BUSY_MAX_ATTEMPTS = 5;

// Compatibility export for callers that reached for the accessor from this
// service before the shared task-target-branch contract existed.
export { resolveTaskTargetBranch as resolveTaskExistingBranch } from '../lib/taskTargetBranch.js';

/**
 * Take over the worktree that already holds `branchName`, for a task whose whole
 * purpose is to run ON that branch (a merge/review-loop follow-up, a resume).
 *
 * Resolved before `createWorktree`, so both a resume and a review-loop follow-up
 * share one answer to "which tree holds this branch?". Routinely that holder is a
 * cleanup's tree seconds from teardown, but a tree `removeWorktree` REFUSED to
 * delete (uncommitted changes) holds the branch until a human intervenes. Adoption
 * is the shorter path in both cases and preserves whatever the previous run left
 * behind.
 *
 * `findAdoptableWorktreeForBranch` refuses every holder PortOS doesn't own
 * outright, so this can never move the user's checkout or a live agent's tree.
 * The one caller-gated exception is `allowLiveClaim`: a non-committing
 * coordinator follow-up (`isNonCommittingCoordinatorTask` — a review-loop
 * resolve-and-merge or a PR-remediation follow-up) may take over a `claim-*`
 * holder too, but only after branch/repository admission verifies that no
 * running or paused claim owner still controls publication and cleanup.
 *
 * @returns {Promise<{ worktreeInfo: object, adoptedFrom: string }|{ refused: string }|null>}
 */
async function adoptWorktreeHoldingBranch({ agentId, workspacePath, branchName, preferredPath = null, taskId, allowLiveClaim = false, deepResume = false, adopt = true, reviewTarget = null, mergeGuardTarget = null, preserveLockfiles = false }) {
  // Fail CLOSED on an unreadable agent list: an empty protected set would read as
  // "nothing is running", which is the one wrong answer here — it would move a
  // live run's directory. The caller's timed pause is the safe outcome instead.
  const { getAgents } = await import('./cosAgentLifecycle.js');
  const agents = await getAgents().catch(err => {
    emitLog('warn', `🌳 Skipping worktree adoption for task ${taskId} — could not read the agent list: ${err.message}`, { taskId });
    return null;
  });
  if (!Array.isArray(agents)) return { refused: 'ownership-unreadable' };
  const worktrees = await listWorktrees(workspacePath).catch(() => null);
  // A branch the primary checkout holds is never adopted, released or waited out:
  // `createWorktree` attaches detached at its head instead.
  if (worktrees?.some(wt => resolve(wt.path) === resolve(workspacePath) && wt.branch?.replace(/^refs\/heads\//, '') === branchName)) return null;
  const admission = claimBranchAdmission({
    branchName, preferredPath: allowLiveClaim ? preferredPath : null,
    agentId, sourceWorkspace: workspacePath, agents, worktrees,
  });
  if (!admission.admit) return { refused: admission.reason };
  const activeAgentIds = protectedAgentIds(agents);

  const holder = adopt && await findAdoptableWorktreeForBranch(workspacePath, branchName, { activeAgentIds, agents, requestingAgentId: agentId, preferredPath, allowLiveClaim });
  if (!holder) {
    // Not adoptable, but a coordinator follow-up may still free the branch from an
    // idle `/do:next` sibling tree by detaching it in place — `createWorktree`
    // then attaches normally instead of waiting out a holder that never leaves.
    if (allowLiveClaim) {
      const activeWorkspacePaths = agents
        .filter(a => activeAgentIds.has(a.id))
        .map(a => a.workspacePath || a.metadata?.workspacePath);
      const released = await releaseIdleSiblingNextHolder(workspacePath, branchName, { activeWorkspacePaths, agents, requestingAgentId: agentId, allowUntracked: true }).catch(err => {
        emitLog('warn', `🌳 Could not release ${branchName} for task ${taskId}: ${err.message}`, { taskId });
        return null;
      });
      if (released) emitLog('info', `🌳 Released ${branchName} from idle worktree ${released.path} for task ${taskId}`, { taskId, branch: branchName });
    }
    return null;
  }

  if (mergeGuardTarget) {
    const { validatePendingMergeRecovery } = await import('./pendingMergeRecovery.js');
    const refused = await validatePendingMergeRecovery({ target: mergeGuardTarget, workspacePath: holder.path, requireCheckout: true, launchTaskId: taskId });
    if (refused) return { refused };
  }
  if (reviewTarget) {
    const { validateCleanupReviewTarget } = await import('./cosMergeHandoff.js');
    const refused = await validateCleanupReviewTarget({ target: reviewTarget, workspacePath: holder.path, requireCheckout: true, launchTaskId: taskId });
    if (refused) return { refused };
  }
  const worktreeInfo = await adoptWorktree(agentId, workspacePath, holder.path, branchName, ...(deepResume || preserveLockfiles ? [{ ...(deepResume && { deepResume }), ...(preserveLockfiles && { preserveLockfiles }) }] : [])).catch(err => {
    if (err.code === 'DEEP_RESUME_PRESERVED') return { refused: err.message };
    emitLog('warn', `🌳 Could not adopt ${holder.path} holding ${branchName} for task ${taskId}: ${err.message}`, { taskId });
    return null;
  });
  if (worktreeInfo?.refused) return { refused: worktreeInfo.refused, deepPreserved: true };
  return worktreeInfo ? { worktreeInfo, adoptedFrom: holder.agentId } : null;
}

/**
 * Free the branch from an ownerless foreign worktree so `createWorktree` can
 * attach. Fails closed: an unreadable agent list is "somebody may own it".
 * @returns {Promise<boolean>} true when the holder was released
 */
async function releaseOwnerlessForeignHolderForTask({ workspacePath, branchName, agentId, taskId }) {
  const { getAgents } = await import('./cosAgentLifecycle.js');
  const agents = await getAgents().catch(() => null);
  if (!Array.isArray(agents)) return false;
  const activeIds = protectedAgentIds(agents);
  const released = await releaseOwnerlessForeignHolder(workspacePath, branchName, {
    agents,
    requestingAgentId: agentId,
    activeWorkspacePaths: agents.filter(a => activeIds.has(a.id)).map(a => a.workspacePath || a.metadata?.workspacePath),
  }).catch(err => {
    emitLog('warn', `🌳 Could not release ${branchName} from its foreign worktree for task ${taskId}: ${err.message}`, { taskId });
    return null;
  });
  if (released) emitLog('info', `🌳 Released ${branchName} from ownerless worktree ${released.path} for task ${taskId}`, { taskId, branch: branchName });
  return Boolean(released);
}

/**
 * The commit a task's branch attach is pinned to, '' when the task needs a pin
 * but carries none, null when it is unpinned. A PR remediation agent runs the
 * PR's own tests, so it may only attach at the head PortOS screened.
 */
function resolveTaskPinnedHead(metadata) {
  if (!isTruthyMeta(metadata?.prRemediationFollowUp)) return null;
  return typeof metadata.prRemediationHeadSha === 'string' ? metadata.prRemediationHeadSha.trim() : '';
}

/**
 * Refuse a pinned attach for good: block the task and give the PR back to its
 * opener. Not a timed pause — a new push needs a new review, which queues a
 * new task pinned to that head.
 */
async function refusePinnedAttach(task, workspacePath, reason) {
  emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
  await blockTask(task, reason, 'pr-head-moved');
  const { handBackPrRemediation } = await import('./prRemediationFollowUp.js');
  await handBackPrRemediation({ task, workspacePath }).catch(err => {
    emitLog('warn', `Could not hand back the PR for task ${task.id}: ${err.message}`, { taskId: task.id });
  });
  return { outcome: 'blocked', reason };
}

/**
 * Provision a worktree that the task explicitly needs, including a safe
 * adoption of a surviving branch holder. This is shared by read-only public
 * review stages and ordinary delivery agents: read-only describes what the
 * model may do inside the tree, not whether the tree itself may be shared with
 * the live checkout.
 */
async function prepareRequestedWorktree({
  agentId,
  workspacePath,
  task,
  existingBranch,
  forkHead,
  allowSharedWorkspaceFallback,
}) {
  // Fail before any git fetch/branch work: a non-git directory can never host a
  // worktree, and the raw `fatal: not a git repository` says nothing actionable.
  if (!(await git.isRepo(workspacePath))) {
    const reason = git.notGitRepoMessage(task.metadata?.app || basename(workspacePath));
    emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
    await blockTask(task, reason, 'worktree-failed');
    return { outcome: 'blocked', reason };
  }
  const reviewTarget = task.metadata?.cleanupReviewTarget;
  const mergeGuardTarget = task.metadata?.pendingMergeGuardTarget;
  const pinnedHead = existingBranch ? resolveTaskPinnedHead(task.metadata) : null;
  if (pinnedHead === '') {
    return refusePinnedAttach(task, workspacePath, `Task ${task.id} must attach at a reviewed head commit but records none; refusing to check out ${existingBranch}`);
  }
  const isolateDependencies = resolveTaskHookType(task) === 'dependency-updates';
  const baseCommit = isLegacyDeepAudit(task.metadata)
    ? await (await import('./deepAudit.js')).getDeepAuditSourceRevision(task)
    : null;
  // Detecting the base branch and resolving the branch holder are independent
  // reads (a git-branches lookup vs. an agent-liveness + worktree-list check) —
  // kick both off before awaiting either so their I/O overlaps instead of
  // serializing on the spawn hot path.
  const detectedBasePromise = git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
  // Resolve the branch holder ONCE before creation. `resumeWorktreePath` is a
  // cache of that answer, not a separate ownership rule: if it is gone or
  // stale, discovery finds the actual holder. This gives resume retries the
  // same safe adoption path review-loop follow-ups use, rather than cutting a
  // fresh branch merely because a cached path could not be moved.
  const resumeWorktreePath = existingBranch ? task.metadata?.resumeWorktreePath : null;
  // Coordinator follow-ups may recover a claim directory only after its owner
  // releases it. Review-only posture never grants another run's merge ownership.
  const takeoverPromise = existingBranch
    ? adoptWorktreeHoldingBranch({
      agentId,
      workspacePath,
      branchName: existingBranch,
      preferredPath: resumeWorktreePath,
      taskId: task.id,
      allowLiveClaim: isNonCommittingCoordinatorTask(task),
      deepResume: isLegacyDeepAudit(task.metadata),
      // A pinned attach never adopts a surviving tree: neither its contents nor
      // its remote tip are proven to be the reviewed commit; only a fresh attach
      // can prove both. Releasing an idle sibling holder in place stays allowed.
      adopt: !pinnedHead,
      reviewTarget,
      mergeGuardTarget,
      preserveLockfiles: isolateDependencies,
    })
    : Promise.resolve(null);

  const { baseBranch: detectedBase } = await detectedBasePromise;
  if (existingBranch) {
    emitLog('info', `🌳 Worktree requested for task ${task.id} on existing branch ${existingBranch}`, {
      taskId: task.id, app: task.metadata?.app, branch: existingBranch
    });
  } else {
    emitLog('info', `🌳 Worktree requested for task ${task.id} — creating isolated worktree from ${detectedBase || 'default branch'}`, {
      taskId: task.id, app: task.metadata?.app, baseBranch: detectedBase
    });
  }

  const takeover = await takeoverPromise;
  const attempt = (Number(task.metadata?.worktreeBusyAttempts) || 0) + 1;
  if (takeover?.refused) {
    if (takeover.deepPreserved) {
      await blockTask(task, takeover.refused, 'deep-audit-partial');
      return { outcome: 'blocked', reason: takeover.refused };
    }
    const reason = `Branch ownership prevents worktree takeover (${takeover.refused}); retrying after a short cooldown`;
    await blockTask(task, reason, attempt <= WORKTREE_BUSY_MAX_ATTEMPTS ? 'worktree-busy' : 'worktree-failed',
      attempt <= WORKTREE_BUSY_MAX_ATTEMPTS ? {
        cooldownUntil: new Date(Date.now() + WORKTREE_BUSY_COOLDOWN_MS).toISOString(),
        worktreeBusyAttempts: attempt,
      } : {});
    return { outcome: 'blocked', reason };
  }

  // The failure reason decides whether the task is unrunnable or merely early.
  let worktreeError = null;
  const create = () => createWorktree(agentId, workspacePath, task.id, {
    baseBranch: detectedBase || undefined,
    ...(baseCommit ? { baseCommit } : {}),
    existingBranch: resolveTaskRemoteBranch(task.metadata) || undefined,
    ...(task.metadata?.existingBranch && task.metadata?.resumedFromAgentId ? { resumeBranch: existingBranch } : {}),
    // Fork coordinates select the remote head, independent of the local branch name.
    forkHead: forkHead || undefined,
    expectedHeadSha: pinnedHead || reviewTarget?.headSha || mergeGuardTarget?.headSha || undefined,
    planId: task.metadata?.planId || undefined,
    linkDependencies: !isolateDependencies,
  });
  let worktreeInfo = takeover?.worktreeInfo || await create().catch(err => {
    worktreeError = err;
    return null;
  });
  // A foreign checkout (a terminal session's own worktree) that holds the branch
  // is never reaped by anything, so waiting out the cooldown cannot free it. If it
  // is ownerless, clean and fully pushed, detach it in place and retry at once.
  if (!worktreeInfo && existingBranch && isBranchCheckedOutElsewhereError(worktreeError?.message)
    && await releaseOwnerlessForeignHolderForTask({ workspacePath, branchName: existingBranch, agentId, taskId: task.id })) {
    worktreeError = null;
    worktreeInfo = await create().catch(err => {
      worktreeError = err;
      return null;
    });
  }
  // A branch still checked out in another worktree is a transient the timed
  // `worktree-busy` pause below retries (and reports at info). Only a failure
  // nothing retries is a fault worth stderr.
  const retriesBusyBranch = Boolean(worktreeError) && !allowSharedWorkspaceFallback
    && worktreeError.code !== PINNED_HEAD_MOVED
    && isBranchCheckedOutElsewhereError(worktreeError.message) && attempt <= WORKTREE_BUSY_MAX_ATTEMPTS;
  if (worktreeError && !retriesBusyBranch) {
    emitLog('warn', `🌳 Worktree creation failed for task ${task.id}: ${worktreeError.message}`, { taskId: task.id });
  }

  if (worktreeInfo) {
    const nextWorkspacePath = worktreeInfo.worktreePath;
    // An adopted tree may predate the dependency-update opt-out. Detach only
    // the source-checkout links; preserve a real install already in the tree.
    if (isolateDependencies && takeover?.worktreeInfo) {
      await unlinkWorktreeDependencies(workspacePath, nextWorkspacePath);
    }
    const origin = worktreeInfo.adopted
      ? `adopted from ${takeover?.adoptedFrom || task.metadata?.resumedFromAgentId || 'the interrupted run'}`
      : `base: ${worktreeInfo.baseBranch}`;
    emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName} (${origin})`, {
      agentId, worktreePath: nextWorkspacePath, branchName: worktreeInfo.branchName, baseBranch: worktreeInfo.baseBranch
    });
    return { outcome: 'ready', workspacePath: nextWorkspacePath, worktreeInfo };
  }

  if (worktreeError?.code === PINNED_HEAD_MOVED) {
    return refusePinnedAttach(task, workspacePath, `Branch ${existingBranch} moved after review (${worktreeError.message}); refusing to run unreviewed commits`);
  }

  if (allowSharedWorkspaceFallback) {
    // Reached here only for a resume pointer on a task that never asked for
    // isolation. Blocking would be STRICTER than the task's own contract — it
    // would have run in the shared workspace before the pointer existed — so
    // degrade to that instead. The resume is lost (the leftover work stays on
    // disk for the next attempt), but the task still runs.
    emitLog('warn', `🌳 Worktree creation failed for task ${task.id}; resuming is not possible, continuing in the shared workspace`, { taskId: task.id });
    return { outcome: 'ready', workspacePath, worktreeInfo: null };
  }

  if (retriesBusyBranch) {
    // The branch is checked out in ANOTHER worktree. Routinely that other
    // worktree is the previous agent's, still being torn down by the very
    // cleanup that spawned this task, so waiting it out lands the pull
    // request a permanent block would have stranded. `worktree-busy` is a
    // TIMED PAUSE (lib/taskBlockCategories.js): the cooldown sweeper revives
    // it, and the pause keeps `existingBranch` so the revived attempt still
    // attaches to the PR branch instead of cutting a fresh one off main.
    const reason = `Branch ${existingBranch || 'for this task'} is still checked out in another worktree; retrying after a short cooldown`;
    emitLog('info', `🌳 ${reason} (attempt ${attempt}/${WORKTREE_BUSY_MAX_ATTEMPTS})`, { taskId: task.id, branch: existingBranch || null });
    await blockTask(task, `${reason}. ${worktreeError?.message || ''}`.trim(), 'worktree-busy', {
      cooldownUntil: new Date(Date.now() + WORKTREE_BUSY_COOLDOWN_MS).toISOString(),
      worktreeBusyAttempts: attempt,
    });
    return { outcome: 'blocked', reason };
  }

  // Isolation was explicitly requested (or is required to reach an existing
  // branch), so falling back to the shared workspace would run the agent
  // against the live checkout. Fail closed: block the task rather than touch
  // the working tree behind the user's back.
  const reason = `Worktree creation failed for task ${task.id}; refusing to run in the shared workspace because isolation was required`;
  emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
  await blockTask(task, `Worktree creation failed — isolation was required${worktreeError?.message ? `: ${worktreeError.message}` : ''}`, 'worktree-failed');
  return { outcome: 'blocked', reason };
}

/**
 * Re-check, at launch, that the claim worktree a cached continuation pointer names
 * is still free to enter. The pointer was written when the previous run died;
 * another owner may have taken the checkout since. Every read fails closed — an
 * unreadable agent list or worktree list is "unknown", never "nobody is there".
 * Read-only: nothing here rebases, commits, pushes, moves or removes.
 */
async function admitClaimContinuation({ task, agentId, sourceWorkspace, claimWorkspace }) {
  const { getAgents } = await import('./cosAgentLifecycle.js');
  const [agents, worktrees] = await Promise.all([
    getAgents().catch(() => null),
    listWorktrees(sourceWorkspace).catch(() => null),
  ]);
  return claimContinuationAdmission({ metadata: task.metadata, agentId, sourceWorkspace, worktrees, agents });
}

/**
 * Prepare the workspace (and any worktree/JIRA branch) for an agent task.
 *
 * @param {{ agentId: string, task: object }} params
 * @returns {Promise<object>} discriminated outcome (see module doc)
 */
export async function prepareAgentWorkspace({ agentId, task, onPrepared = result => result }) {
  if (isPrivateSecurityTask(task)) {
    const { privateSecurityScratchCwd } = await import('../lib/privateSecuritySandbox.js');
    const workspacePath = privateSecurityScratchCwd(agentId);
    await ensureDir(workspacePath);
    return onPrepared({ outcome: 'ready', workspacePath, resolvedApp: null, resolvedAppName: null, worktreeInfo: null,
      jiraTicket: null, jiraBranchName: null, explicitWorktree: false });
  }

  // Creative Director treatment/plan/evaluate tasks are HTTP-PATCH deliverables
  // and never asked for a worktree. Pin them to an isolated scratch cwd BEFORE
  // the PortOS-root resolution / git-pull / conflict scan, so a CLI/TUI provider
  // cannot natively discover the repo AGENTS.md tree (#4650).
  if (usesCreativeDirectorScratchCwd(task)) {
    const workspacePath = creativeDirectorScratchCwd(agentId);
    await ensureDir(workspacePath);
    // Codex (and any CLI that refuses a non-git cwd) needs a repo root here.
    // Initializing INSIDE the scratch makes the scratch itself the git root, so
    // native AGENTS.md discovery cannot walk up into the PortOS checkout —
    // `--skip-git-repo-check` would only cover Codex's exec path, not TUI.
    await execGit(['init'], workspacePath).catch((err) => {
      emitLog('warn', `⚠️ CD scratch git init failed for ${agentId}: ${err.message}`, {
        taskId: task.id, workspace: workspacePath,
      });
    });
    emitLog('info', `📂 Agent workspace: ${workspacePath} (creative-director scratch)`, {
      taskId: task.id, workspace: workspacePath,
    });
    return onPrepared({
      outcome: 'ready',
      workspacePath,
      resolvedApp: null,
      resolvedAppName: null,
      worktreeInfo: null,
      jiraTicket: null,
      jiraBranchName: null,
      explicitWorktree: false,
    });
  }

  // Pre-change investigation tasks may already be persisted without delivery
  // flags. Normalize them at the last common spawn boundary so an old queued
  // investigation cannot fall back to committing in the shared checkout.
  if (isInvestigationTask(task)) {
    task.metadata = { ...(task.metadata || {}), ...INVESTIGATION_TASK_DELIVERY };
  }

  // Determine workspace path and resolve app name
  const isReadOnly = isTruthyMeta(task.metadata?.readOnly);
  let workspacePath = task.metadata?.app
    ? await getAppWorkspace(task.metadata.app)
    : ROOT_DIR;
  // The record itself, not just its name: the spawn also needs its `workTracker`
  // pin to resolve the forge behind the workspace's origin (a self-hosted forge
  // on a neutral domain is classified by that pin alone), and reading it twice
  // would be two `getAppById` calls for one record.
  const resolvedApp = task.metadata?.app
    ? await getAppById(task.metadata.app).catch(() => null)
    : null;
  const resolvedAppName = resolvedApp?.name || null;

  // Refuse to run an agent whose app didn't resolve to a usable directory.
  // Previously both failures fell through to the PortOS root and the agent
  // silently did its work in the PortOS checkout instead of the user's app
  // (issue #3180) — a wrong-repo commit is far worse than a blocked task, and
  // the block carries the exact thing to fix. Validated ONCE here rather than in
  // each of the three spawn helpers (TUI / runner / direct), which all take
  // their cwd from this function.
  if (task.metadata?.app && !workspacePath) {
    // The reason line is now the whole Blocked card, so it has to cover both
    // ways this resolves to nothing: the app is registered but carries no
    // Repository Path, OR nothing in Apps matches that id/name at all (the
    // shape a task gets when a producer used `app` as a feature tag rather
    // than as routing — see migration 234).
    const reason = `App '${task.metadata.app}' didn't resolve to a repository directory — it must name an app in Apps `
      + `that has a Repository Path set. Fix the app (or clear it from the task), then re-run this task. `
      + `(The agent was not started, so it could not write into the PortOS directory by mistake.)`;
    emitLog('error', `❌ ${reason}`, { taskId: task.id });
    await blockTask(task, reason, 'app-unresolved');
    return onPrepared({ outcome: 'blocked', reason });
  }
  // Same resolver the /runs spawn paths use, so a `~/Projects/App` repoPath
  // expands here too and a repoPath pointing at a FILE is rejected up front
  // rather than flowing into the git operations below with a non-directory cwd.
  // Reusing it is what keeps the two validation sites from drifting — an
  // inline existsSync here did both of those wrong.
  try {
    // The source repo is validated here and logged later, after a worktree (if
    // any) replaces it. Logging it as the task cwd made every isolated run look
    // like it was about to edit the primary checkout.
    workspacePath = resolveSpawnCwd(workspacePath, ROOT_DIR, `Task ${task.id}`, { log: false });
  } catch (err) {
    const reason = `${err.message} (Task blocked before the agent started, so it could not write into the PortOS directory by mistake.)`;
    emitLog('error', `❌ ${reason}`, { taskId: task.id, workspace: workspacePath });
    // A task with no `app` lands here only if the PortOS root itself is
    // unusable, which is a different problem than a mis-configured app record —
    // don't file it under the app category.
    await blockTask(task, reason, task.metadata?.app ? 'app-unresolved' : 'workspace-invalid');
    return onPrepared({ outcome: 'blocked', reason });
  }

  const prepareAndRegister = async () => {
    const result = await prepareResolvedWorkspace({ agentId, task, workspacePath, resolvedApp, resolvedAppName, isReadOnly });
    if (result.outcome === 'ready' && task.metadata?.pendingMergeGuardTarget) {
      const { validatePendingMergeRecovery } = await import('./pendingMergeRecovery.js');
      const refused = await validatePendingMergeRecovery({ target: task.metadata.pendingMergeGuardTarget, workspacePath: result.workspacePath, requireCheckout: true, launchTaskId: task.id });
      if (refused) {
        await blockTask(task, refused, 'pr-head-moved');
        return onPrepared({ outcome: 'blocked', reason: refused });
      }
      task.metadata.pendingMergeGuardLaunchEvidence = task.metadata.pendingMergeGuardTarget;
      task.metadata.pendingMergeGuardTarget = undefined;
      result.cleanupReviewPinConsumed = true;
    }
    if (result.outcome === 'ready' && task.metadata?.cleanupReviewTarget) {
      const { validateCleanupReviewTarget } = await import('./cosMergeHandoff.js');
      const refused = await validateCleanupReviewTarget({ target: task.metadata.cleanupReviewTarget, workspacePath: result.workspacePath, requireCheckout: true, launchTaskId: task.id });
      if (refused) {
        await blockTask(task, refused, 'pr-head-moved');
        return onPrepared({ outcome: 'blocked', reason: refused });
      }
      // This is an initial-launch pin. Dispatch registers the owner, then saves
      // this metadata before starting the provider. A pre-registration failure
      // leaves the persisted pin intact; a registered coordinator may fix code
      // and resume under its existing ownership/budget without the initial SHA
      // blocking its own new commits. Keep the admission as historical evidence.
      task.metadata.cleanupReviewLaunchEvidence = task.metadata.cleanupReviewTarget;
      task.metadata.cleanupReviewTarget = undefined;
      result.cleanupReviewPinConsumed = true;
    }
    return onPrepared(result);
  };
  // Resolve once, then admit the entire preparation → registration → spawn
  // lifetime. A create/adopt helper's shorter permit cannot protect dependency
  // changes or an owner which has not yet been durably registered.
  const probe = await execGit(['rev-parse', '--is-inside-work-tree'], workspacePath, { ignoreExitCode: true });
  if (probe.stdout.trim() !== 'true') {
    if (probe.exitCode === 128 && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/im.test(probe.stderr || '')) return prepareAndRegister();
    throw new Error('Cannot establish workspace repository identity before dispatch');
  }
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(workspacePath, prepareAndRegister);
}

/**
 * Refuse a launch whose recovery target or remediation pin no longer matches the
 * task, before any checkout is touched.
 * @returns {Promise<object|null>} the blocked outcome, or null to proceed
 */
async function refuseUnsafeLaunchTarget({ task, workspacePath }) {
  const guardTarget = task.metadata?.pendingMergeGuardTarget;
  if (guardTarget) {
    const { validatePendingMergeRecovery } = await import('./pendingMergeRecovery.js');
    const refused = guardTarget.repoPath !== workspacePath || resolveTaskTargetBranch(task.metadata) !== guardTarget.branch || prHeldForOperator(task)
      || resolvePrCompletion(task.metadata) !== guardTarget.prCompletion
      ? 'recovery-target-task-changed' : await validatePendingMergeRecovery({ target: guardTarget, workspacePath, launchTaskId: task.id });
    if (refused) {
      await blockTask(task, refused, 'pr-head-moved');
      return { outcome: 'blocked', reason: refused };
    }
  }
  const recoveryTarget = task.metadata?.cleanupReviewTarget;
  if (recoveryTarget) {
    const { validateCleanupReviewTarget } = await import('./cosMergeHandoff.js');
    const refused = recoveryTarget.repoPath !== workspacePath || resolveTaskTargetBranch(task.metadata) !== recoveryTarget.branch || prHeldForOperator(task)
      ? 'review-target-task-changed' : await validateCleanupReviewTarget({ target: recoveryTarget, workspacePath, launchTaskId: task.id });
    if (refused) {
      await blockTask(task, refused, 'pr-head-moved');
      return { outcome: 'blocked', reason: refused };
    }
  }
  const remediationPin = resolveTaskPinnedHead(task.metadata);
  if (remediationPin !== null && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(remediationPin)
    || !resolveTaskRemoteBranch(task.metadata))) {
    return refusePinnedAttach(task, workspacePath, `Task ${task.id} has no valid reviewed head and branch; refusing an unpinned remediation workspace`);
  }
  return null;
}

/**
 * A relaunched claim keeps the `claim-*` directory the previous run cut. Moving
 * it (the ordinary adopt path) would rename it to `agent-<id>` and break the
 * claim prompt's own cleanup path, so it is used where it sits.
 *
 * The pointer is a cached answer, not authority: confirm the holder, the branch
 * and the absence of another live owner NOW, and wait (bounded) when that cannot
 * be established rather than entering someone's checkout.
 *
 * @returns {Promise<{ workspacePath: string, worktreeInfo: object }|object|null>}
 *   the claim checkout, a blocked outcome, or null when the task continues no claim
 */
async function admitClaimWorkspace({ task, agentId, workspacePath }) {
  const claimWorkspace = claimContinuationWorkspace({
    metadata: task.metadata,
    pathExists: existsSync,
    worktreesRoot: PATHS.worktrees,
  });
  if (!claimWorkspace) return null;
  const { branchName } = claimWorkspace.worktreeInfo;
  const admission = await admitClaimContinuation({ task, agentId, sourceWorkspace: workspacePath, claimWorkspace });
  if (admission.admit) {
    emitLog('info', `🌳 Agent ${agentId} is continuing the claim worktree ${branchName}`, {
      agentId, taskId: task.id, worktreePath: claimWorkspace.workspacePath, branchName,
    });
    return { workspacePath: claimWorkspace.workspacePath, worktreeInfo: claimWorkspace.worktreeInfo };
  }
  const attempt = (Number(task.metadata?.worktreeBusyAttempts) || 0) + 1;
  const detail = `The claim worktree for ${branchName} cannot be confirmed free (${admission.reason}); nothing in it was touched`;
  if (attempt <= WORKTREE_BUSY_MAX_ATTEMPTS) {
    emitLog('info', `🌳 ${detail}; retrying after a short cooldown (attempt ${attempt}/${WORKTREE_BUSY_MAX_ATTEMPTS})`, { taskId: task.id, branch: branchName, reason: admission.reason });
    await blockTask(task, `${detail}; retrying after a short cooldown`, 'worktree-busy', {
      cooldownUntil: new Date(Date.now() + WORKTREE_BUSY_COOLDOWN_MS).toISOString(),
      worktreeBusyAttempts: attempt,
    });
    return { outcome: 'blocked', reason: detail };
  }
  emitLog('warn', `🌳 ${detail}; giving up after ${WORKTREE_BUSY_MAX_ATTEMPTS} attempts`, { taskId: task.id, branch: branchName, reason: admission.reason });
  await blockTask(task, `${detail}. Resolve who owns the checkout, then re-run this task.`, 'worktree-failed');
  return { outcome: 'blocked', reason: detail };
}

/**
 * File a resolver task for the shared checkout that will not pull, and pause this
 * task on a cooldown until it lands.
 */
async function deferForGitConflict({ task, workspacePath, resolvedAppName, pullResult }) {
  emitLog('warn', `🔀 Git conflict in ${workspacePath} (branch: ${pullResult.branch}): ${pullResult.error}`, {
    taskId: task.id, workspace: workspacePath, branch: pullResult.branch
  });
  const checkoutName = resolvedAppName || workspacePath;
  // The description's first line is the duplicate key, so it stays stable
  // across retries; the (varying) git error goes in the context.
  await addTask({
    description: `Resolve git conflict in ${checkoutName} on branch ${pullResult.branch}. `
      + `The branch has diverged from origin and automatic rebase failed.`,
    priority: 'HIGH',
    app: task.metadata?.app || null,
    metadata: { gitConflictResolution: true },
    context: `Error: ${pullResult.error}\n`
      + `This conflict is blocking task ${task.id}: "${task.description}". `
      + `Resolve the conflict, commit, and push so the blocked task can proceed.`,
    position: 'top'
  }, 'internal').catch(err => {
    emitLog('warn', `Failed to create conflict resolution task: ${err.message}`, { taskId: task.id });
  });

  // A timed pause, not `pending`: a pending task is re-dequeued within
  // seconds and re-runs the same failing rebase in a hot loop until the
  // resolver lands. The cooldown sweeper revives it.
  await blockTask(task, `Git conflict in ${checkoutName} (branch ${pullResult.branch}); waiting for the resolver task`, 'git-conflict-wait', {
    cooldownUntil: new Date(Date.now() + GIT_CONFLICT_COOLDOWN_MS).toISOString(),
  });
  return {
    outcome: 'deferred',
    reason: 'Git conflict blocks task — conflict resolution task created',
    deferReason: 'git-conflict',
    branch: pullResult.branch
  };
}

/**
 * Pull the shared checkout a task is about to run in.
 * @returns {Promise<object|null>} the deferred outcome on an unresolvable conflict, else null
 */
async function pullSharedCheckout({ task, workspacePath, resolvedAppName, wantsWorktree }) {
  // Isolated tasks fetch their base in createWorktree; never rebase the
  // shared checkout as a side effect of preparing a separate workspace.
  // The conflict-resolution task works on the very checkout that won't pull;
  // gating it on a clean pull would defer it forever.
  const pullResult = wantsWorktree ? { skipped: 'isolated-task' }
    : isTruthyMeta(task.metadata?.gitConflictResolution) ? { skipped: 'git-conflict-resolver' }
    : await git.ensureLatest(workspacePath).catch(err => {
      emitLog('warn', `⚠️ Pre-task git pull failed for ${workspacePath}: ${err.message}`, { taskId: task.id, workspace: workspacePath });
      return { success: false, error: err.message };
    });

  if (pullResult.skipped) {
    emitLog('debug', `Pre-task git pull skipped: ${pullResult.skipped}`, { taskId: task.id, workspace: workspacePath });
  } else if (pullResult.conflict) {
    return deferForGitConflict({ task, workspacePath, resolvedAppName, pullResult });
  } else if (pullResult.success && !pullResult.upToDate) {
    emitLog('info', `📥 Pulled latest for ${resolvedAppName || 'workspace'} (branch: ${pullResult.branch})`, {
      taskId: task.id, workspace: workspacePath, branch: pullResult.branch
    });
  } else if (!pullResult.success) {
    emitLog('warn', `⚠️ Pre-task git pull error: ${pullResult.error}`, { taskId: task.id, workspace: workspacePath });
  }
  return null;
}

/**
 * Create a JIRA ticket and its feature branch when the app has JIRA enabled and
 * the task opted in. Writes nothing to the task: the fields the ticket adds to
 * `task.metadata` are returned as `metadataPatch` for the caller to record.
 *
 * @returns {Promise<{ jiraTicket: object|null, jiraBranchName: string|null, metadataPatch: object|null }>}
 *   `jiraBranchName` is null when the branch could not be created, even with a ticket
 */
async function prepareJiraBranch({ task, workspacePath }) {
  const none = { jiraTicket: null, jiraBranchName: null, metadataPatch: null };
  if (!task.metadata?.createJiraTicket) return none;
  const appData = await getAppDataForTask(task);
  if (!appData?.jira?.enabled) return none;
  const jiraTicket = await createJiraTicketForTask(task, appData);
  if (!jiraTicket) return none;

  const slug = (task.description || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  let jiraBranchName = `feature/${jiraTicket.ticketId}-${slug}`;

  if (task.metadata?.app) {
    await git.fetchOrigin(workspacePath).catch(() => {});
    const { baseBranch: defaultBranch } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
    if (defaultBranch) {
      await git.checkout(workspacePath, defaultBranch).catch(() => {});
      await execGit(['merge', '--ff-only', `origin/${defaultBranch}`], workspacePath).catch(err => { emitLog('warn', `Fast-forward merge of ${defaultBranch} failed: ${err.message}`, { taskId: task.id }); });
    }
  }

  await git.createBranch(workspacePath, jiraBranchName)
    // `checkout -b` off a LOCAL branch doesn't auto-track under git's default
    // `branch.autoSetupMerge`, but a repo configured `always` records the base
    // branch as this one's upstream — and a config-derived push
    // (`git push <remote> HEAD:<merge>`) then lands the agent's work on the base
    // branch instead of opening a PR (#4172). Verify before handing it over.
    .then(() => enforceSafeBranchUpstream(workspacePath, jiraBranchName))
    .then(() => {
      emitLog('success', `Created feature branch ${jiraBranchName}`, { taskId: task.id, ticketId: jiraTicket.ticketId });
    })
    .catch(err => {
      emitLog('warn', `Failed to create JIRA branch ${jiraBranchName}: ${err.message}`, { taskId: task.id });
      jiraBranchName = null;
    });

  return {
    jiraTicket,
    jiraBranchName,
    metadataPatch: {
      jiraTicketId: jiraTicket.ticketId,
      jiraTicketUrl: jiraTicket.ticketUrl,
      jiraBranch: jiraBranchName,
      jiraInstanceId: appData.jira.instanceId,
      jiraCreatePR: appData.jira.createPR !== false
    },
  };
}

/**
 * A feature-agent run works in that agent's persistent worktree instead of a
 * fresh one.
 * @returns {Promise<{ workspacePath: string, worktreeInfo: object }|null>}
 */
async function adoptFeatureAgentWorktree(task) {
  if (!task.metadata?.featureAgentRun || !task.metadata?.featureAgentId) return null;
  const { getFeatureAgent } = await import('./featureAgents.js');
  const fa = await getFeatureAgent(task.metadata.featureAgentId).catch(() => null);
  if (!fa) return null;
  const faWorktreePath = join(PATHS.cos, 'feature-agents', fa.id, 'worktree');
  if (!existsSync(faWorktreePath)) return null;
  if (fa.git.autoMergeBase) {
    const { mergeBaseIntoFeatureWorktree } = await import('./worktreeManager.js');
    await mergeBaseIntoFeatureWorktree(fa.id, fa.git.baseBranch).catch(err => {
      emitLog('warn', `🌳 Feature agent base merge failed: ${err.message}`, { featureAgentId: fa.id });
    });
  }
  emitLog('info', `🌳 Feature agent ${fa.name} using persistent worktree: ${fa.git.branchName}`, {
    featureAgentId: fa.id, worktreePath: faWorktreePath
  });
  return {
    workspacePath: faWorktreePath,
    worktreeInfo: {
      worktreePath: faWorktreePath,
      branchName: fa.git.branchName,
      baseBranch: fa.git.baseBranch || 'main',
      isPersistentWorktree: true
    },
  };
}

/**
 * Cut a worktree for a shared-checkout task only when conflict detection finds
 * another running agent in the same checkout. Creation failure keeps the task
 * in the shared checkout.
 * @returns {Promise<object|null>} the new worktree's info, or null to stay put
 */
async function provisionConflictWorktree({ agentId, task, workspacePath }) {
  const { getAgents } = await import('./cosAgentLifecycle.js');
  const runningAgents = (await getAgents()).filter(a => a.status === 'running');

  const conflictResult = await detectConflicts(task, workspacePath, runningAgents).catch(err => {
    emitLog('warn', `Conflict detection failed: ${err.message}`, { taskId: task.id });
    return { hasConflict: false, recommendation: 'proceed' };
  });

  if (conflictResult.recommendation === 'proceed') {
    emitLog('debug', `No conflicts for task ${task.id}, using shared workspace`, { taskId: task.id });
  }
  if (conflictResult.recommendation !== 'worktree') return null;

  emitLog('info', `🌳 Conflict detected for task ${task.id}: ${conflictResult.reason} — creating worktree`, {
    taskId: task.id,
    conflictingAgents: conflictResult.conflictingAgents,
    reason: conflictResult.reason
  });
  const worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
    planId: task.metadata?.planId || undefined,
    linkDependencies: resolveTaskHookType(task) !== 'dependency-updates',
  }).catch(err => {
    emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
    return null;
  });
  if (worktreeInfo) {
    emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName}`, {
      agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName
    });
  }
  return worktreeInfo;
}

/**
 * Pick the checkout the agent runs in. The provisioning steps run in this fixed
 * order and any refusal, deferral, continued claim or JIRA branch returns at
 * once, so a later step never has to infer an earlier outcome from a flag.
 */
async function prepareResolvedWorkspace({ agentId, task, workspacePath: sourceWorkspace, resolvedApp, resolvedAppName, isReadOnly }) {
  const refusal = await refuseUnsafeLaunchTarget({ task, workspacePath: sourceWorkspace });
  if (refusal) return refusal;

  const remediationPin = resolveTaskPinnedHead(task.metadata);
  const explicitWorktree = isTruthyMeta(task.metadata?.useWorktree) || isTruthyMeta(task.metadata?.openPR) || remediationPin !== null;
  // A task pointed at an existing branch must run in a worktree whatever isolated
  // the ORIGINAL run, because that is the only way to reach the work: the branch
  // has to be checked out somewhere, and an adoptable tree has to be attached.
  // Keyed on `existingBranch` so it covers both producers — a resume pointer and
  // the review-loop follow-up. Without it, a run that got its worktree from
  // conflict AUTO-detection resumes into the shared workspace on retry (conflict
  // detection returns `proceed` once the dead agent is gone) and silently
  // abandons the work the pointer was recorded to save.
  const existingBranch = resolveTaskTargetBranch(task.metadata);
  const wantsWorktree = explicitWorktree || !!existingBranch;
  const ready = ({ workspacePath, worktreeInfo, jiraTicket = null, jiraBranchName = null }) => {
    // Announce the FINAL cwd, after any worktree reassignment, so the task log
    // names the directory the agent actually runs in rather than the repo it was
    // cut from (#3180).
    emitLog('info', `📂 Agent workspace: ${workspacePath}`, { taskId: task.id, workspace: workspacePath });
    return { outcome: 'ready', workspacePath, resolvedApp, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree };
  };

  // A checked-out claim branch skips every later provisioner so it cannot fall
  // through to the shared checkout. A remediation follow-up never continues one.
  const claim = remediationPin === null ? await admitClaimWorkspace({ task, agentId, workspacePath: sourceWorkspace }) : null;
  if (claim?.outcome) return claim;
  if (claim) return ready(claim);

  let jira = { jiraTicket: null, jiraBranchName: null };
  let featureCheckout = null;
  if (!isReadOnly) {
    const deferred = await pullSharedCheckout({ task, workspacePath: sourceWorkspace, resolvedAppName, wantsWorktree });
    if (deferred) return deferred;
    jira = await prepareJiraBranch({ task, workspacePath: sourceWorkspace });
    if (jira.metadataPatch) task.metadata = { ...task.metadata, ...jira.metadataPatch };
    featureCheckout = await adoptFeatureAgentWorktree(task);
  }
  const current = { workspacePath: sourceWorkspace, worktreeInfo: null, ...featureCheckout, jiraTicket: jira.jiraTicket, jiraBranchName: jira.jiraBranchName };
  // The JIRA feature branch was cut in the shared checkout; the agent works there.
  if (current.jiraBranchName) return ready(current);

  // A read-only public-review stage still needs a disposable checkout: it may
  // run repository commands and the action stage's provider-specific sandbox
  // needs it for tests/patch inspection. Never let `readOnly` turn an explicit
  // isolation request into the live application checkout.
  if (wantsWorktree) {
    const worktreeOutcome = await prepareRequestedWorktree({
      agentId,
      workspacePath: current.workspacePath,
      task,
      existingBranch,
      // Where that branch lives when the task points at a fork PR's head — read
      // here rather than inside the worktree layer, which has no forge client.
      forkHead: resolveTaskForkHead(task.metadata),
      allowSharedWorkspaceFallback: !isReadOnly && !explicitWorktree,
    });
    if (worktreeOutcome.outcome !== 'ready') return worktreeOutcome;
    return ready({ ...current, workspacePath: worktreeOutcome.workspacePath, worktreeInfo: worktreeOutcome.worktreeInfo });
  }

  if (!isReadOnly && !isFalsyMeta(task.metadata?.useWorktree)) {
    const conflictWorktree = await provisionConflictWorktree({ agentId, task, workspacePath: current.workspacePath });
    if (conflictWorktree) return ready({ ...current, workspacePath: conflictWorktree.worktreePath, worktreeInfo: conflictWorktree });
  }
  return ready(current);
}
