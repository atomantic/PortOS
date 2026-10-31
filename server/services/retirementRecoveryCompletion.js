import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { matchingRetirementReceipts } from '../lib/reconcileRetirementEvidence.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { PR_COMPLETIONS, prHeldForOperator, prStaysOpen } from '../lib/prDisposition.js';

// A delivery-repair recovery still owns its PR/review/commit gates.
const hasRetirementTarget = task => task?.taskType === 'internal'
  && task.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup' && !!task.metadata?.retirementReview;
export const isRetirementOnlyRecovery = task => hasRetirementTarget(task) && !task.metadata?.recoveryMergeTarget;

const unverified = (reason, target = null) => ({ status: 'unverified', reason, target });

/** Metadata selects a target; only a server-written parent backlink (or the
 * original dispatch reservation plus captured physical checkout) authorizes it.
 * No task prose, success report, ancestry or activity in the source repo counts.
 */
export async function verifyRetirementRecoveryCompletion(input) {
  if (!hasRetirementTarget(input)) return null;
  const { withClaimOwnershipLock } = await import('./cosClaimOwnership.js');
  return withClaimOwnershipLock(() => verifyCurrentRetirement(input))
    .catch(() => unverified('retirement-evidence-unreadable'));
}

async function verifyCurrentRetirement(input) {
  let target = null;
  try {
    const { getTaskById } = await import('./cosTaskStore.js');
    const task = await getTaskById(input.id);
    if (!hasRetirementTarget(task) || !isDeepStrictEqual(task.metadata.retirementReview, input.metadata.retirementReview)
      || !isDeepStrictEqual(task.metadata.recoveryOrigin, input.metadata.recoveryOrigin)
      || !isDeepStrictEqual(task.metadata.recoveryMergeTarget, input.metadata.recoveryMergeTarget)) return unverified('retirement-task-changed');
    target = task.metadata.retirementReview;
    const { release, appId, createdAt } = target;
    if (!appId || !release?.branch || !release.path || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(release.head || '')
      || !/^[a-f0-9]{64}$/.test(release.checkoutIdentity || '') || !Number.isFinite(Date.parse(createdAt))
      || Date.parse(createdAt) > Date.now()) return unverified('retirement-target-unverified', target);
    if (prHeldForOperator(task)) return unverified('retirement-human-handoff', target);
    const { getAgentRecord } = await import('./cosAgentLifecycle.js');
    const origin = task.metadata.recoveryOrigin;
    const parent = await getAgentRecord(origin.parentAgentId);
    if (!parent || parent.id !== origin.parentAgentId || parent.status !== 'completed' || parent.taskId !== origin.parentTaskId
      || prStaysOpen(parent) || parent.metadata?.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN) return unverified('retirement-parent-unverified', target);
    const link = parent.metadata?.repoStateRecoveries?.[release.branch] || parent.metadata?.repoStateRecovery;
    let repoPath = null;
    if (link?.taskId === task.id && link.branch === release.branch && isDeepStrictEqual(link.retirementReview, target)) {
      repoPath = link.repoPath;
    } else {
      // Compatibility for dispatches created before exact retirement backlinks.
      // Neither the reservation nor task metadata alone can supply a generation.
      const reservation = parent.metadata?.repoCleanupRecoveries?.[release.branch];
      const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
      const captured = parent.metadata?.completedCheckouts?.find(row => completedCheckoutReceiptValid(parent, row)
        // Git inventory and realpath use different separators on Windows. The
        // retired checkout is gone; compare spellings without filesystem reads.
        && row.branch === release.branch && typeof row.path === 'string' && resolve(row.path) === resolve(release.path) && row.head === release.head
        && retirementCheckoutIdentityFromPointer(row.incarnation?.pointer) === release.checkoutIdentity);
      if (reservation?.taskId === task.id && reservation.observation === origin.observation && captured) repoPath = captured.repoPath;
    }
    const { getAppById } = await import('./apps.js');
    const app = await getAppById(appId);
    if (!repoPath || !app?.repoPath || await realpath(repoPath) !== await realpath(app.repoPath)) return unverified('retirement-repository-unverified', target);
    const { getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
    const outcome = await getBranchReconcileOutcome(appId);
    const receipts = matchingRetirementReceipts(outcome, release).filter(row => row.archiveDir === null
      && row.checkoutIdentity === release.checkoutIdentity && Date.parse(row.retiredAt) >= Date.parse(createdAt)
      && Date.parse(row.retiredAt) <= Date.now());
    if (!receipts.length) return unverified('retirement-receipt-unverified', target);
    const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
    const { claimCheckoutOwner } = await import('../lib/claimContinuation.js');
    const owner = claimCheckoutOwner({ branchName: release.branch, holderPath: release.path, sourceWorkspace: repoPath,
      agents: await readClaimOwnershipAgents() });
    if (owner) return unverified(owner.reason, target);
    const [{ readCheckoutPathPresence, readLocalBranchPresence }, { listWorktrees }, { listRemoteHeads }] = await Promise.all([
      import('./repoCleanupObservation.js'), import('./worktreeManager.js'), import('./branchReconcile.js'),
    ]);
    const [present, local, trees, remote] = await Promise.all([
      readCheckoutPathPresence(release.path), readLocalBranchPresence(repoPath, release.branch),
      listWorktrees(repoPath), listRemoteHeads(repoPath),
    ]);
    if (present !== false) return unverified(present ? 'retirement-checkout-present' : 'retirement-checkout-unreadable', target);
    if (local !== false) return unverified(local ? 'retirement-ref-present' : 'retirement-ref-unreadable', target);
    if (!Array.isArray(trees) || !trees.length || !remote) return unverified('retirement-inventory-unreadable', target);
    if (trees.some(row => row.path === release.path || row.branch?.replace(/^refs\/heads\//, '') === release.branch)
      || remote.has(release.branch)) return unverified('retirement-ref-present', target);
    return { status: 'verified', reason: 'retirement-receipt-verified', target, receipt: receipts[0], parent: { id: parent.id, startedAt: parent.startedAt } };
  } catch {
    return unverified('retirement-evidence-unreadable', target);
  }
}

/** Post-completion settlement shares precisely the finalizer's proof. */
export async function recordRetirementRecoveryCompletion(agent, verdict) {
  if (!verdict) return;
  const { recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
  const { release, appId, createdAt } = verdict.target || {};
  await recordCleanupOutcome(agent.id, { ...release, status: verdict.status === 'verified' ? 'verified' : 'blocked', reason: verdict.reason });
  if (verdict.status !== 'verified' && appId && release?.branch && release.path && release.head) {
    const { recordBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
    await recordBranchReconcileOutcome(appId, {
      status: 'incomplete', reason: verdict.reason,
      retirementObligations: [{ ...release, createdAt, reason: 'retirement-receipt-unverified' }],
      nextAction: 'Retain the exact cleanup obligation until its service receipt and checkout/ref absence can be verified.',
    });
  }
}

/** Resolve an already-satisfied queued attempt before charging another spawn.
 * The task-store comparison prevents a stale snapshot from overwriting an edit.
 * Historical failed runs and the original attempt/spawn budgets stay intact.
 */
export async function settleRetirementRecoveryBeforeSpawn(task) {
  if (!isRetirementOnlyRecovery(task)) return false;
  const { withClaimOwnershipLock } = await import('./cosClaimOwnership.js');
  return withClaimOwnershipLock(async () => {
    const { getTaskById, updateTask } = await import('./cosTaskStore.js');
    const fresh = await getTaskById(task.id);
    if (!fresh || !['pending', 'approved'].includes(fresh.status) || !isRetirementOnlyRecovery(fresh)) return true;
    const proof = await verifyCurrentRetirement(fresh);
    if (proof?.status !== 'verified') return false;
    const { loadState } = await import('./cosState.js');
    const { hasActiveTaskOwner } = await import('./agentState.js');
    if (hasActiveTaskOwner(fresh.id, (await loadState()).agents)) return false;
    const result = await updateTask(fresh.id, { status: 'completed', metadata: {
      taskOutcome: { status: 'no-action-needed', reason: proof.reason },
      retirementCompletion: { status: proof.status, reason: proof.reason, target: proof.target },
    } }, fresh.taskType, { expectedStatus: fresh.status,
      expectedTask: { description: fresh.description, priority: fresh.priority, metadata: fresh.metadata },
      recoveryOwner: proof.parent, suppressDequeue: true });
    if (!result || result.error) throw new Error('retirement-task-settlement-unavailable');
    return true;
  });
}
