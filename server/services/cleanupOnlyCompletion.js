import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isSafeGitRef } from '../lib/gitArgs.js';
import { agentPrHeldForOperator, prHeldForOperator } from '../lib/prDisposition.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';

const isRepositoryCleanup = task => task?.taskType === 'internal'
  && task.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup';
// Delivery repair still owns its PR, review and commit gates.
export const isCleanupOnlyRecovery = task => isRepositoryCleanup(task) && !task.metadata?.recoveryMergeTarget;
// A pre-existing delivery repair that also persisted a target keeps its cleanup bookkeeping.
const hasCleanupScope = task => isCleanupOnlyRecovery(task) || (isRepositoryCleanup(task) && !!task.metadata?.retirementReview);

/** The one metadata shape the divergence producer persists. Completion reads
 * `retirementReview` back, so a retirement-only recovery must carry its target. */
export function repositoryCleanupRecoveryMetadata({ parentAgentId, parentTaskId = null, attempt, observation, mergeTarget = null, target = null }) {
  return { recoveryOrigin: { parentAgentId, parentTaskId, subsystem: 'repository-cleanup', attempt, observation, noProgress: false },
    ...(mergeTarget ? { recoveryMergeTarget: mergeTarget } : {}),
    ...(target ? { retirementReview: target } : {}) };
}

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
  if (!hasCleanupScope(input)) return null;
  return verifyCurrentCleanup(input).catch(() => ({ status: 'unverified', reason: 'cleanup-state-unreadable',
    target: input.metadata.retirementReview }));
}

async function verifyCurrentCleanup(input) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(input.id);
  let target = input.metadata.retirementReview;
  const unverified = reason => ({ status: 'unverified', reason, target });
  if (!hasCleanupScope(task) || !isDeepStrictEqual(task.metadata.retirementReview, target)
    || !isDeepStrictEqual(task.metadata.recoveryOrigin, input.metadata.recoveryOrigin)
    || !isDeepStrictEqual(task.metadata.recoveryMergeTarget, input.metadata.recoveryMergeTarget)) return unverified('cleanup-task-changed');
  if (prHeldForOperator(task)) return unverified('cleanup-human-handoff');
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const parentId = task.metadata.recoveryOrigin.parentAgentId;
  const parent = parentId ? await getAgentRecord(parentId) : null;
  if (!parent || parent.id !== parentId || parent.taskId !== task.metadata.recoveryOrigin.parentTaskId) return unverified('cleanup-parent-unavailable');
  if (agentPrHeldForOperator(parent, parent)) return unverified('cleanup-parent-human-handoff');
  const recorded = target ? null : await resolveRecordedCleanupTarget(task, parent);
  if (recorded?.reason) return unverified(recorded.reason);
  if (recorded) target = recorded.target;
  const { getAppById } = await import('./apps.js');
  const app = await getAppById(target.appId);
  if (recorded) {
    const canonical = path => (path ? realpath(path).catch(() => null) : null);
    const [appRepo, capturedRepo] = await Promise.all([canonical(app?.repoPath), canonical(recorded.repoPath)]);
    if (!appRepo || appRepo !== capturedRepo) return unverified('cleanup-app-scope-mismatch');
  }
  return { ...await observeCleanupTarget(app?.repoPath, target.release), target };
}

/** Recoveries filed without a persisted target (#16059) resolve it only from
 * server-written parent evidence: the dispatch backlink naming this task with
 * the same observation, and the parent's own captured checkout of that branch.
 * Task text, API-written paths and current inventory grant nothing. */
async function resolveRecordedCleanupTarget(task, parent) {
  const origin = task.metadata.recoveryOrigin;
  const appId = task.metadata.app;
  if (typeof appId !== 'string' || !appId) return { reason: 'cleanup-app-scope-unavailable' };
  const links = Object.entries(parent.metadata?.repoCleanupRecoveries || {}).filter(([, link]) => link?.taskId === task.id);
  if (links.length !== 1) return { reason: links.length ? 'cleanup-backlink-ambiguous' : 'cleanup-backlink-missing' };
  const [branch, link] = links[0];
  if (typeof origin.observation !== 'string' || link.observation !== origin.observation || link.attempt !== origin.attempt) {
    return { reason: 'cleanup-observation-mismatch' };
  }
  const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
  const rows = [...(parent.metadata?.completedCheckouts || []), ...(parent.metadata?.checkoutCapture?.targets || [])];
  const captures = new Map(rows.filter(row => row?.branch === branch && completedCheckoutReceiptValid(parent, row)
    && typeof row.repoPath === 'string' && typeof row.path === 'string' && typeof row.head === 'string')
    .map(row => [JSON.stringify([row.repoPath, row.path, row.head]), row]));
  if (captures.size !== 1) return { reason: captures.size ? 'cleanup-capture-ambiguous' : 'cleanup-capture-missing' };
  const [capture] = captures.values();
  return { repoPath: capture.repoPath, target: { appId, release: { branch, path: capture.path, head: capture.head } } };
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
