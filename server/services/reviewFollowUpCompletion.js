/** A merged assigned PR completes a review/merge follow-up, independently of
 * preserved work that needs a separate delivery. Never infer this from prose,
 * local ancestry, a branch lookup alone, or an unavailable forge.
 */
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { prHeldForOperator } from '../lib/prDisposition.js';

export async function verifyMergedReviewFollowUp(task, workspacePath) {
  const meta = task?.metadata;
  if (task?.taskType !== 'internal' || !isTruthyMeta(meta?.reviewLoopFollowUp)
    // A held PR's follow-up was never assigned the merge, so a merge cannot discharge it.
    || prHeldForOperator(task) || !workspacePath
    || typeof meta.reviewLoopPRBranch !== 'string' || !meta.reviewLoopPRBranch.trim()) return null;
  const target = parsePullRequestUrl(meta.reviewLoopPRUrl);
  if (!target) return null;
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(workspacePath);
  if (origin?.host !== target.host || origin?.fullName !== `${target.owner}/${target.repo}`) return null;
  const { probeChangeRequestState } = await import('./prProbe.js');
  const state = await probeChangeRequestState(workspacePath, { number: target.number, branch: meta.reviewLoopPRBranch });
  return state.readable === true && state.prState === 'MERGED'
    ? { status: 'verified', prUrl: meta.reviewLoopPRUrl } : null;
}

/** Settle only the assigned review/merge work before allocating another agent.
 * A saved cleanup/delivery/resume target is independent work, not discharged by
 * the PR being merged. Its existing proof/retirement path remains authoritative.
 * Only `completed` means this call persisted a terminal transition; `skip` also
 * stops stale dispatches but must not wake the queue as a new completion.
 */
export async function settleMergedReviewFollowUpBeforeSpawn(input) {
  const meta = input?.metadata;
  if (input?.taskType !== 'internal' || !isTruthyMeta(meta?.reviewLoopFollowUp) || !meta.app || isTruthyMeta(meta.readOnly)
    || ['retirementReview', 'recoveryOrigin', 'recoveryMergeTarget', 'cleanupReviewTarget', 'cleanupReviewLaunchEvidence',
      'pendingMergeGuardTarget', 'pendingMergeGuardLaunchEvidence', 'resumedFromAgentId', 'resumeWorktreePath',
      'existingBranch', 'deliveryRecovery'].some(key => meta[key])) return false;
  const { isDeepStrictEqual } = await import('node:util');
  const { getTaskById, updateTask } = await import('./cosTaskStore.js');
  const fresh = await getTaskById(input.id);
  if (!fresh || !['pending', 'approved'].includes(fresh.status)
    || fresh.taskType !== input.taskType || !isDeepStrictEqual(fresh.metadata, meta)
    || fresh.description !== input.description || fresh.priority !== input.priority) return 'skip';
  const expectedTask = structuredClone({ description: fresh.description, priority: fresh.priority, metadata: fresh.metadata });
  const { getAppById } = await import('./apps.js');
  const app = await getAppById(meta.app);
  if (app?.id !== meta.app || typeof app.repoPath !== 'string' || !app.repoPath) return false;
  const repoPath = app.repoPath;
  // Network reads do not hold the shared checkout ownership fence. The exact
  // task/app and live ownership are re-read under it immediately before CAS.
  const proof = await verifyMergedReviewFollowUp(fresh, repoPath).catch(() => null);
  if (!proof) return false;
  const { withClaimOwnershipLock } = await import('./cosClaimOwnershipState.js');
  return withClaimOwnershipLock(async () => {
    const current = await getTaskById(fresh.id);
    if (!current || current.status !== fresh.status || current.taskType !== fresh.taskType
      || Object.entries(expectedTask).some(([key, value]) => !isDeepStrictEqual(current[key], value))) return 'skip';
    const currentApp = await getAppById(meta.app);
    if (currentApp?.id !== meta.app || currentApp.repoPath !== repoPath) return 'skip';
    const { loadState } = await import('./cosState.js');
    const { hasActiveTaskOwner } = await import('./agentState.js');
    if (hasActiveTaskOwner(fresh.id, (await loadState()).agents)) return 'skip';
    const result = await updateTask(fresh.id, { status: 'completed', metadata: {
      taskOutcome: { status: 'no-action-needed', reason: 'The assigned review/merge target is verified merged.' },
      mergedReviewFollowUp: proof, reviewLoopRetiredReason: 'pull-request-merged-before-follow-up',
    } }, fresh.taskType, { expectedStatus: fresh.status, expectedTask, suppressDequeue: true });
    if (!result || result.error) throw new Error('merged-review-task-settlement-unavailable');
    // A stale write refusal also stops this stale dispatch, without completing
    // the edited/claimed task or altering any original attempt/spawn budget.
    return result.statusChanged || result.status !== 'completed' ? 'skip' : 'completed';
  });
}
