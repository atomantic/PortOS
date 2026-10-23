import { processAuditFingerprint } from '../lib/persistentMindProcessAudit.js';
import { resolvePrCompletion } from '../lib/prDisposition.js';

const purposeFor = (inspection, repair) => {
  if (inspection?.disposition === 'review-required') return 'required-review';
  if (inspection?.disposition !== 'held' || !['review-not-required', 'review-recorded-handoff-missing'].includes(inspection.reason)
    || !inspection.reviewTarget || repair?.head !== inspection.reviewTarget.headSha) return null;
  return repair.conflicts === true || repair.changesRequested === true || repair.checks?.length > 0 ? 'code-repair' : null;
};
const observationFor = (inspection, purpose, repair) => processAuditFingerprint({ kind: purpose,
  target: inspection.reviewTarget, roster: inspection.roster, policy: resolvePrCompletion(inspection.originalTask?.metadata),
  ...(purpose === 'code-repair' ? { repair } : {}),
});

/** Queue genuine required review or exact-head code repair, never a CI wait.
 * Uses the existing review-loop owner and budget, without merge admission bypass.
 */
export async function inspectOrQueueCompletedReview(input, deps = {}) {
  const inspect = deps.inspect || (await import('./cosMergeHandoff.js')).inspectCompletedOwnerReview;
  const inspected = await inspect(input);
  const purpose = purposeFor(inspected, input.repairEvidence);
  if (!purpose) return inspected;
  const target = inspected.reviewTarget;
  if (!target || !inspected.agentId || !inspected.originalTask || !inspected.roster) return { disposition: 'held', reason: 'review-obligation-unverified' };
  const permitted = deps.permitted || (await import('./branchReconcileRetirement.js')).assertAutomaticRetirementAllowed;
  try { await permitted(); } catch (error) { return { disposition: 'held', reason: error.message }; }
  const observation = observationFor(inspected, purpose, input.repairEvidence);
  const lifecycle = deps.lifecycle || await import('./cosAgentLifecycle.js');
  const reservation = await lifecycle.reserveRepoCleanupRecovery(inspected.agentId, target.branch, observation);
  if (!reservation?.admitted) return { disposition: 'held', reason: reservation?.reason || 'review-reservation-unavailable' };
  // Reservation may wait behind another state writer. Re-prove the same
  // obligation and current authority after that await, before task publication.
  const fresh = await inspect(input).catch(() => null);
  let freshRepair = input.repairEvidence;
  if (purpose === 'code-repair') {
    const readDelivery = deps.readDelivery || (await import('./repoCleanupObservation.js')).inspectOpenDeliveryRepair;
    const delivery = await readDelivery(target.repoPath, target.branch, target.prUrl, { forgeAccount: input.forgeAccount ?? null }).catch(() => null);
    freshRepair = delivery?.actionable ? delivery.evidence : null;
  }
  const unchanged = fresh?.agentId === inspected.agentId && purposeFor(fresh, freshRepair) === purpose
    && observationFor(fresh, purpose, freshRepair) === observation;
  let refusal = unchanged ? null : 'review-obligation-changed';
  if (!refusal) { try { await permitted(); } catch (error) { refusal = error.message; } }
  if (refusal) {
    await lifecycle.recordRepoCleanupRecovery(inspected.agentId, target.branch, observation,
      { phase: 'blocked-before-dispatch', taskId: null, reason: refusal });
    return { disposition: 'held', reason: refusal };
  }
  const queueReview = deps.spawn || (await import('./agentWorktreeCleanup.js')).spawnReviewLoopFollowUp;
  let task;
  try {
    task = await queueReview({ originalAgentId: inspected.agentId, originalTask: inspected.originalTask,
      sourceWorkspace: target.repoPath, prUrl: target.prUrl, prBranch: target.branch,
      prCompletion: resolvePrCompletion(inspected.originalTask.metadata), ...inspected.roster, reviewTarget: target });
  } catch {
    // Publication may already have committed. Retain uncertainty until an exact
    // successor can be identified, never reset its budget or blindly redispatch.
    return { disposition: 'held', reason: 'cleanup-publication-unverified' };
  }
  // An existing coordinator id is also returned on a refused resume. Keep its
  // ownership link without claiming it was queued or retrying its spent budget.
  const queued = Boolean(task?.id && !task.blocked && !task.deferred);
  const phase = queued ? 'dispatched' : task?.deferred ? 'deferred' : 'blocked';
  const reason = task?.blocked || (task?.deferred ? 'required-code-review-deferred'
    : queued ? (purpose === 'code-repair' ? 'code-repair-queued' : 'required-code-review-queued') : 'required-code-review-held');
  await lifecycle.recordRepoCleanupRecovery(inspected.agentId, target.branch, observation,
    { phase, taskId: task?.id || null, reason });
  await lifecycle.recordCleanupOutcome(inspected.agentId, { branch: target.branch, path: target.worktreePath,
    status: queued ? 'pending' : 'blocked', reason, taskId: task?.id || null });
  return { disposition: queued ? 'queued-review' : 'held', reason, taskId: task?.id || null };
}
