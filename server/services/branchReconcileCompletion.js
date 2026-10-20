import { hasRetirementReceipt, unresolvedRetirements } from '../lib/reconcileRetirementEvidence.js';
import { getAppById } from './apps.js';
import { getTaskById } from './cosTaskStore.js';
import { getActiveAgentIds } from './agentState.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile, buildActiveOwnerIds, describeIdleReconcilePark } from './branchReconcile.js';
import { emitLog } from './cosEvents.js';

/** Finish deterministic cleanup without requiring another provider dispatch. */
export async function settleBranchReconcileRun(agent) {
  const type = agent?.metadata?.taskAnalysisType || agent?.metadata?.analysisType || agent?.metadata?.selfImprovementType;
  if (type !== 'branch-reconcile') return null;
  const task = await getTaskById(agent.taskId);
  // The task holds the resolved per-app toggles. Missing records cannot grant cleanup.
  if (!task?.metadata || task.metadata.cleanupMerged === false) return null;
  const app = await getAppById(agent.metadata.taskApp);
  if (!app?.repoPath) throw new Error('Branch reconciliation completion target unavailable');
  const agents = await readClaimOwnershipAgents();
  if (!Array.isArray(agents)) throw new Error('Branch reconciliation ownership state unavailable');
  // Branches queued for the pr-watcher merge coordinator count as owned (#12258).
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const pendingMergeBranches = new Set(readPendingMergePrs(app).map((entry) => entry?.prBranch).filter(Boolean));
  const result = await reconcile(app.repoPath, {
    cleanup: true,
    pendingMergeBranches,
    activeAgentIds: buildActiveOwnerIds(getActiveAgentIds(), agents),
    claimOwners: { agents, readAgents: readClaimOwnershipAgents },
    forgeAccount: app.forgeAccount || null
  });
  const { getBranchReconcileOutcome, recordBranchReconcileOutcome } = await import('./taskSchedule.js');
  const outcome = await getBranchReconcileOutcome(app.id);
  const unverifiedRetirements = unresolvedRetirements(outcome,
    (task.metadata.reconcileRetirements || []).map(({ release, createdAt }) => ({ ...release, createdAt, reason: 'retirement-review-pending' })));
  if (task.metadata.reconcileRetirements?.length) {
    const missing = task.metadata.reconcileRetirements.filter(({ release, createdAt }) => !hasRetirementReceipt(outcome, { ...release, createdAt }));
    if (missing.length) {
      await recordBranchReconcileOutcome(app.id, {
        status: 'incomplete', reason: agent.result?.success === false ? 'retirement-review-failed' : 'retirement-receipt-unverified',
        retirementObligations: missing.map(({ release, createdAt }) => ({ ...release, createdAt, reason: 'retirement-receipt-unverified' })),
        nextAction: 'Inspect the scoped review task and retained checkout; retirement requires a verified archive receipt.',
      });
      emitLog('warn', `Branch reconciliation retained ${missing.length} review obligation(s) without verified retirement receipts`, { appId: app.id, taskId: agent.taskId });
    }
  }
  const inFlightBranches = new Set((result.inFlight || []).map(branch => branch.branch));
  const holds = describeIdleReconcilePark([...(result.skipped || []), ...unverifiedRetirements], [], {
    wip: result.wip, detachedWorktrees: result.detachedWorktrees,
    superseded: result.superseded, claimMarkersHeld: result.claimMarkersHeld,
    // Actionable branches are counted separately; the helper deduplicates all
    // remaining checkout projections and includes retained claim reservations.
    worktreeInventory: result.worktreeInventory?.filter(tree => !inFlightBranches.has(tree.branch)) ?? null,
  });
  const uncertain = unverifiedRetirements.length > 0 || result.forgeUnavailable || result.prStateUnavailable
    || result.worktreeInventory == null || result.orphanRemotes?.remoteUnavailable;
  const remaining = inFlightBranches.size + holds.remaining.length;
  emitLog(uncertain || remaining ? 'warn' : 'info',
    `Branch reconciliation completion: cleaned ${result.cleaned.length}, superseded ${result.reapedSuperseded?.length || 0}, remaining ${remaining}${uncertain ? '; scan incomplete' : ''}`,
    { appId: app.id, analysisType: type, counts: holds.counts, skipCauses: holds.skipCauses });
  return result;
}

/** Recovery success is not preservation evidence. This path never scans or mutates Git. */
export async function settleRetirementReviewRun(agent) {
  if (agent?.metadata?.recoveryOrigin?.subsystem !== 'repository-cleanup') return null;
  const task = await getTaskById(agent.taskId);
  const target = task?.metadata?.retirementReview;
  if (!target?.appId || !target.release?.branch || !target.release.path || !target.release.head) return null;
  const { getBranchReconcileOutcome, recordBranchReconcileOutcome } = await import('./taskSchedule.js');
  const outcome = await getBranchReconcileOutcome(target.appId);
  if (hasRetirementReceipt(outcome, { ...target.release, createdAt: target.createdAt })) return { verified: true };
  await recordBranchReconcileOutcome(target.appId, {
    status: 'incomplete', reason: 'retirement-receipt-unverified',
    retirementObligations: [{ ...target.release, reason: 'retirement-receipt-unverified' }],
    nextAction: 'Inspect the scoped cleanup recovery and archive evidence; an agent success report cannot release this obligation.',
  });
  emitLog('warn', 'Cleanup recovery completed without a verified retirement receipt; exact checkout obligation retained', {
    appId: target.appId, taskId: agent.taskId, branch: target.release.branch,
  });
  return { verified: false };
}
