/** File recovery tasks for diverged agent branches with the verified observation and remediation instructions. */

import { isDeepStrictEqual } from 'node:util';
import { isMergeHandoffEnabled, MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../../lib/mergeGateContract.js';
import { processAuditFingerprint } from '../../lib/persistent/persistentMindProcessAudit.js';
import { isGitCommitSha } from '../completedCheckoutEvidence.js';
import { repositoryCleanupRecoveryMetadata } from '../cleanupOnlyCompletion.js';
import { emitLog } from '../cos/cosEvents.js';
import { addTask, getTaskById } from '../cos/cosTaskStore.js';
import { driveToMerge } from '../branchReconcile.js';
import { execGit } from '../../lib/execGit.js';
import { RECOVERY_TASK_PREFIX } from '../recoveryTasks.js';
import { REPO_STATE_ISSUES } from '../../lib/repoStateExpectations.js';
import { loadState } from '../cos/cosState.js';

export async function fileDivergenceRecovery({ agentId, task, appId, sourceWorkspace, branchName, worktreePath, observed, issues, record, blockWith, agentState }, retirement) {
  const stateConfig = (await loadState().catch(() => null))?.config;
  if (stateConfig && stateConfig.autoApproveInvestigations !== true) {
    emitLog('info', `🔎 Diverged branch ${branchName} after ${agentId} deferred to scheduled branch-reconcile`, { agentId, branchName, taskId: task?.id });
    // Scheduling reconciliation preserves the checkout, but does not discharge its owner's cleanup obligation.
    if (agentState?.result?.cleanupPending === true) return blockWith('deferred-to-branch-reconcile', { issues, observed });
    if (record) await record('verified', 'deferred-to-branch-reconcile', { unresolved: 0 });
    return { verified: true, skipReason: 'deferred-to-branch-reconcile', issues, observed, recoveryTaskId: null };
  }
  // The recovery task filed below is the investigation, so this line only records the divergence; filing failures still warn.
  emitLog('info', `🔎 Repo state diverged after ${agentId}: ${issues.map(i => i.code).join(', ')}`, { agentId, branchName, taskId: task?.id });

  const recoveryTaskId = await fileRepoStateRecoveryTask({
    agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement,
  }).catch(err => {
    emitLog('warn', `Failed to file repo-state recovery task for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  return { verified: false, skipReason: null, issues, observed, recoveryTaskId };
}
/**
 * The remediation step for each issue code, as an instruction the recovery agent
 * can follow without re-deriving the diagnosis.
 *
 * A map rather than a switch with a `default`, so a new code cannot ship without
 * one — `repoStateExpectations.test.js` asserts the two key sets match.
 * `PR_UNMERGED` delegates to branch-reconcile's `driveToMerge`, which carries the
 * caveats a hand-written line loses: preserve the linked checkout (gh can implicitly delete a
 * branch checked out elsewhere), retry `--squash`/`--rebase` on "not allowed",
 * verify the exact-head server handoff and preserve the checkout for API review.
 */
export const REPO_STATE_REMEDIATIONS = Object.freeze({
  [REPO_STATE_ISSUES.WORKTREE_PRESENT]: ({ worktreePath }) =>
    `Keep the retained worktree ${worktreePath} intact until branch-reconcile removes it. A merged checkout is retired directly through the exact branch-reconcile inventory; unmerged work stays. Do not copy the checkout into an archive.`,
  [REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT]: ({ branchName }) =>
    `Keep local branch ${branchName} until branch-reconcile removes it with ok:true and branchDeleted:true. Missing checkout or merged status is not permission for shell deletion.`,
  [REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT]: ({ branchName }) =>
    `Leave remote branch ${branchName} to the service's fresh exact-head cleanup. An advanced or unreadable ref is a hold; do not use a generic delete API or merge deletion flag.`,
  [REPO_STATE_ISSUES.BRANCH_UNMERGED]: ({ base }) =>
    `The branch has work not proven integrated in ${base}. Inspect whether it remains wanted, finish its draft PR, review and required checks, then complete the authorized merge. Preserve all unmerged or superseded work for explicit review; do not merge into the primary checkout or discard it.`,
  // Forge-aware: `driveToMerge` emits a `gh pr merge` procedure, which a GitLab
  // recovery agent cannot run. Its non-gh caveats still apply on either forge —
  // merge from the repo ROOT and preserve all checkout/ref evidence.
  [REPO_STATE_ISSUES.PR_UNMERGED]: ({ prUrl, prNumber, forgeCli, mergeHandoff }) => (forgeCli === 'glab'
    ? `Finish the merge request${prUrl ? ` ${prUrl}` : ''}: fix failing pipeline jobs and resolve review threads, retain delivery ownership until required checks and reviews pass, recheck CI, applicable reviews and forge merge eligibility for the same full head SHA, then merge from the repo ROOT with "glab mr merge ${prNumber ?? '<iid>'} --yes --sha <ci-verified-sha>" using that verified SHA while preserving source branches and checkouts until delivery is confirmed. Independently confirm the forge reports this exact merge request as MERGED; never request source-branch deletion during merge.`
    : `Finish the pull request${prUrl ? ` ${prUrl}` : ''}. ${driveToMerge(prUrl || '<num>', { mergeHandoff })}`),
});

/**
 * File ONE recovery task covering every issue found for this branch.
 *
 * Dedup rides on `addTask`'s first-line + app matching: the description names the
 * branch, so a re-run of the same audit joins the existing task rather than
 * stacking a second one.
 *
 * @returns {Promise<string|null>} the task id, or null when it was a duplicate
 */
async function fileRepoStateRecoveryTask({ agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement = null }) {
  const appName = task?.metadata?.appName || appId || 'PortOS';
  const base = observed.defaultBranch || 'the default branch';
  // The handoff is opt-in per app; a lookup failure keeps it off (the safe default).
  const ownerApp = appId ? await (await import('../apps.js')).getAppById(appId).catch(() => null) : null;
  const ctx = { branchName, base, prUrl: observed.prUrl, prNumber: observed.prNumber, worktreePath, forgeCli: observed.forgeCli,
    mergeHandoff: isMergeHandoffEnabled(ownerApp?.mergeHandoffMinQueuedRuns) };

  const retirementInstructions = `Only after independently confirming delivery through the forge (this exact PR/MR reports MERGED), request branch-reconcile through POST /api/cos/schedule/trigger with ${JSON.stringify({ taskType: 'branch-reconcile', appId })} using authenticated PortOS transport. Keep checkout and refs for its exact inventory and retirement: a merged checkout is removed with its branch. Report cleanup pending until branch-reconcile removes it with ok:true and branchDeleted:true. Do not copy the checkout into an archive.`;
  const context = [
    'An agent finished successfully but the repository did not end up in the expected state.',
    '',
    `Repository: ${sourceWorkspace}`,
    `Branch: ${branchName}`,
    `Worktree: ${worktreePath}`,
    `Default branch: ${base}`,
    observed.prUrl ? `Change request: ${observed.prUrl} (${observed.prState || 'state unknown'})` : 'Change request: none found',
    `Original agent: ${agentId}`,
    `Original task: ${task?.description || 'unknown'}`,
    '',
    'Your mission has TWO required parts:',
    '1. Resolve the diverged branch/worktree: finish and merge the PR if it contains valid task work, or clean up the worktree and branch if the work is already superseded or unneeded.',
    `2. Investigate WHY the original agent (${agentId}) exited without completing delivery/cleanup cleanly, and fix or file an issue for the underlying PortOS pipeline cause so it does not happen again.`,
    '',
    'What diverged:',
    ...issues.map((i, n) => `${n + 1}. ${i.message}`),
    '',
    MANAGED_WORKTREE_CLEANUP_CONTRACT,
    '',
    'Finish delivery before retirement; retain anything whose evidence or ownership is uncertain:',
    ...issues.map((i, n) => `${n + 1}. ${REPO_STATE_REMEDIATIONS[i.code](ctx)}`),
    '',
    retirementInstructions,
    '',
    `Rules: preserve wanted unmerged work until it is delivered. Retirement requires service-verified merged delivery: a PR merged at the exact head, or merged commits (on ${base} or inside a later merged PR head) with a clean checkout. A merged checkout is removed in place; do not copy it into an archive. `
      + `Other agents are running concurrently with their own worktrees and branches; touch ONLY ${branchName} and its worktree. `
      + `Do not switch branches in ${sourceWorkspace} itself.`,
  ].join('\n');

  const head = await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)
    .then(result => result.exitCode === 0 ? result.stdout.trim() : null).catch(() => null);
  if (!isGitCommitSha(head)
    || (retirement && retirement.release.head !== head)) return null;
  const observation = processAuditFingerprint({ branchName, worktreePath, head, prUrl: observed.prUrl,
    codes: issues.map(issue => issue.code).sort(), merged: observed.branchMerged,
    remotePresent: observed.remoteBranchPresent, prState: observed.prState,
    // Stable observation: periodic checks alone do not create new work.
    work: 'delivery-repair' });
  const { reserveRepoCleanupRecovery, recordRepoCleanupRecovery, recordCleanupOutcome } = await import('../cos/cosAgentLifecycle.js');
  const reservation = await reserveRepoCleanupRecovery(agentId, branchName, observation);
  if (!reservation?.admitted) {
    await recordCleanupOutcome(agentId, { status: 'blocked', reason: reservation?.reason || 'cleanup-observation-unavailable', branch: branchName, path: worktreePath });
    return null;
  }

  // Completion observes this exact inventoried target; without it a
  // retirement-only recovery has no deterministic criterion (#16059).
  const cleanupTarget = retirement && appId ? { appId, release: retirement.release } : null;
  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName} in ${appName}`,
    priority: 'HIGH',
    app: appId || undefined,
    isRecovery: true,
    metadata: repositoryCleanupRecoveryMetadata({ parentAgentId: agentId, parentTaskId: task?.id || null,
      attempt: reservation.attempt, observation, target: cleanupTarget }),
    context,
    useWorktree: false,
  }, 'internal');

  await recordRepoCleanupRecovery(agentId, branchName, observation, { phase: created?.id ? 'dispatched' : 'blocked', taskId: created?.id || null });
  await recordCleanupOutcome(agentId, { status: 'pending', reason: 'cognitive-review-pending', branch: branchName, path: worktreePath, taskId: created?.id || null });
  if (created?.duplicate) {
    emitLog('info', `🔎 Repo-state recovery for ${branchName} already queued as ${created.id}`, { agentId, branchName });
    // Never bind an unrelated task matched only by description deduplication.
    const duplicate = await getTaskById(created.id).catch(() => null);
    const origin = duplicate?.metadata?.recoveryOrigin;
    const sameScope = !!cleanupTarget && isDeepStrictEqual(duplicate?.metadata?.retirementReview, cleanupTarget);
    if (origin?.parentAgentId !== agentId || origin?.parentTaskId !== task?.id
      || origin?.subsystem !== 'repository-cleanup' || !sameScope) return null;
  }
  emitLog('info', `🔧 Filed repo-state recovery task for ${branchName} (${issues.length} issue(s))`, { agentId, branchName, appName });
  return created?.id || null;
}
