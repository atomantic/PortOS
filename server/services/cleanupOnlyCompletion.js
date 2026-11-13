import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isSafeGitRef } from '../lib/gitArgs.js';
import { agentPrHeldForOperator, prHeldForOperator } from '../lib/prDisposition.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';

const hasCleanupTarget = task => task?.taskType === 'internal'
  && task.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup' && !!task.metadata?.retirementReview;
// Delivery repair still owns its PR, review and commit gates.
export const isCleanupOnlyRecovery = task => hasCleanupTarget(task) && !task.metadata?.recoveryMergeTarget;

/** Observe local cleanup, not delivery or who removed it. The retirement service
 * owns authorization before deletion; completion needs no historical receipt. */
export async function observeCleanupTarget(repoPath, release) {
  if (!repoPath || typeof release?.path !== 'string' || !isAbsolute(release.path)
    || typeof release.branch !== 'string' || !isSafeGitRef(release.branch)) {
    return { status: 'unverified', reason: 'cleanup-target-unverified' };
  }
  const [checkout, branch] = await Promise.all([
    readCheckoutPathPresence(release.path), readLocalBranchPresence(repoPath, release.branch),
  ]);
  if (checkout !== false) return { status: 'unverified', reason: checkout === true ? 'cleanup-checkout-present' : 'cleanup-checkout-unreadable' };
  if (branch !== false) return { status: 'unverified', reason: branch === true ? 'cleanup-ref-present' : 'cleanup-ref-unreadable' };
  return { status: 'verified', reason: 'cleanup-local-target-absent' };
}

export async function verifyCleanupCompletion(input) {
  if (!hasCleanupTarget(input)) return null;
  return verifyCurrentCleanup(input).catch(() => ({ status: 'unverified', reason: 'cleanup-state-unreadable',
    target: input.metadata.retirementReview }));
}

async function verifyCurrentCleanup(input) {
  if (!hasCleanupTarget(input)) return null;
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(input.id);
  const target = input.metadata.retirementReview;
  const unverified = reason => ({ status: 'unverified', reason, target });
  if (!hasCleanupTarget(task) || !isDeepStrictEqual(task.metadata.retirementReview, target)
    || !isDeepStrictEqual(task.metadata.recoveryOrigin, input.metadata.recoveryOrigin)
    || !isDeepStrictEqual(task.metadata.recoveryMergeTarget, input.metadata.recoveryMergeTarget)) return unverified('cleanup-task-changed');
  if (prHeldForOperator(task)) return unverified('cleanup-human-handoff');
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const parentId = task.metadata.recoveryOrigin.parentAgentId;
  const parent = parentId ? await getAgentRecord(parentId) : null;
  if (!parent || parent.id !== parentId) return unverified('cleanup-parent-unavailable');
  if (agentPrHeldForOperator(parent, parent)) return unverified('cleanup-parent-human-handoff');
  const { getAppById } = await import('./apps.js');
  const app = await getAppById(target.appId);
  return { ...await observeCleanupTarget(app?.repoPath, target.release), target };
}

export async function recordCleanupCompletion(agent, verdict) {
  const { recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
  await recordCleanupOutcome(agent.id, { ...verdict.target?.release,
    status: verdict.status === 'verified' ? 'verified' : 'blocked', reason: verdict.reason });
}

/** Avoid another provider dispatch when Git already confirms local cleanup.
 * Keep the task-store compare and active-owner fence so edits and live runs win. */
export async function settleCleanupBeforeSpawn(task) {
  if (!isCleanupOnlyRecovery(task)) return false;
  const { withClaimOwnershipLock } = await import('./cosClaimOwnership.js');
  return withClaimOwnershipLock(async () => {
    const { getTaskById, updateTask } = await import('./cosTaskStore.js');
    const fresh = await getTaskById(task.id);
    if (!fresh || !['pending', 'approved'].includes(fresh.status) || !isCleanupOnlyRecovery(fresh)
      || !isDeepStrictEqual(fresh.metadata, task.metadata)) return true;
    const proof = await verifyCleanupCompletion(fresh);
    if (proof?.status !== 'verified') return false;
    const result = await updateTask(fresh.id, { status: 'completed', metadata: {
      taskOutcome: { status: 'no-action-needed', reason: proof.reason },
      retirementCompletion: proof,
    } }, fresh.taskType, { expectedStatus: fresh.status,
      expectedTask: { description: fresh.description, priority: fresh.priority, metadata: fresh.metadata },
      recoveryOwner: { requireInactive: true }, suppressDequeue: true });
    if (!result || result.error) throw new Error('cleanup-task-settlement-unavailable');
    return true;
  });
}
