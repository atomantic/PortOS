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
  const app = agent.metadata.taskApp ? await getAppById(agent.metadata.taskApp) : null;
  if (!app?.repoPath) {
    // A missing target is an explained refusal, not a defect: record it and stop.
    const { recordBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
    await recordBranchReconcileOutcome(agent.metadata.taskApp || null, {
      status: 'incomplete', reason: 'no-managed-app-target',
      nextAction: 'Run branch reconciliation against a managed app.',
    });
    emitLog('warn', 'Branch reconciliation skipped: no managed app target', { taskId: agent.taskId });
    return null;
  }
  const agents = await readClaimOwnershipAgents();
  if (!Array.isArray(agents)) throw new Error('Branch reconciliation ownership state unavailable');
  // Branches queued for the pr-watcher merge coordinator count as owned (#12258).
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const pendingMergeBranches = new Set(readPendingMergePrs(app).map((entry) => entry?.prBranch).filter(Boolean));
  const result = await reconcile(app.repoPath, {
    appId: app.id,
    cleanup: true,
    reapSuperseded: task.metadata.reapSuperseded !== false,
    pendingMergeBranches,
    activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds()), agents),
    claimOwners: { agents, readAgents: readClaimOwnershipAgents },
    forgeAccount: app.forgeAccount || null
  });
  const { getBranchReconcileOutcome, recordBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
  const outcome = await getBranchReconcileOutcome(app.id);
  const { recordRepoCleanupRecovery, recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
  for (const target of task.metadata.reconcileRetirements || []) {
    if (target.cognition?.ownerAgentId && target.cognition.observation) {
      await recordRepoCleanupRecovery(target.cognition.ownerAgentId, target.release.branch, target.cognition.observation,
        { phase: 'completed', taskId: task.id });
    }
    const verified = hasRetirementReceipt(outcome, { ...target.release, createdAt: target.createdAt });
    await recordCleanupOutcome(agent.id, { ...target.release, status: verified ? 'verified' : 'blocked',
      reason: verified ? 'retirement-receipt-verified' : 'retirement-receipt-unverified' });
  }
  const unverifiedRetirements = unresolvedRetirements(outcome,
    (task.metadata.reconcileRetirements || []).map(({ release, createdAt }) => ({ ...release, createdAt, reason: 'retirement-review-pending' })));
  if (task.metadata.reconcileRetirements?.length) {
    const missing = task.metadata.reconcileRetirements.filter(({ release, createdAt }) => !hasRetirementReceipt(outcome, { ...release, createdAt }));
    if (missing.length) {
      await recordBranchReconcileOutcome(app.id, {
        status: 'incomplete', reason: agent.result?.success === false ? 'retirement-review-failed' : 'retirement-receipt-unverified',
        retirementObligations: missing.map(({ release, createdAt }) => ({ ...release, createdAt, reason: 'retirement-receipt-unverified' })),
        nextAction: 'Inspect the scoped review task and retained checkout; retirement requires ok:true and branchDeleted:true with no archive directory.',
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
  // Branches left to live owners are the normal outcome; only an incomplete scan is an anomaly.
  emitLog(uncertain ? 'warn' : 'info',
    `Branch reconciliation completion: cleaned ${result.cleaned.length}, superseded ${result.reapedSuperseded?.length || 0}, remaining ${remaining}${uncertain ? '; scan incomplete' : ''}`,
    { appId: app.id, analysisType: type, counts: holds.counts, skipCauses: holds.skipCauses });
  return result;
}

/** Recovery success is not preservation evidence. This path never scans or mutates Git. */
export async function settleRetirementReviewRun(agent) {
  if (agent?.metadata?.recoveryOrigin?.subsystem !== 'repository-cleanup') return null;
  const task = await getTaskById(agent.taskId);
  const { verifyRetirementRecoveryCompletion, recordRetirementRecoveryCompletion } = await import('./retirementRecoveryCompletion.js');
  const verdict = await verifyRetirementRecoveryCompletion(task);
  if (!verdict) {
    const { recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
    await recordCleanupOutcome(agent.id, { status: 'blocked', reason: 'legacy-cleanup-receipt-unverified' });
    return { verified: false };
  }
  await recordRetirementRecoveryCompletion(agent, verdict);
  return { verified: verdict.status === 'verified' };
}
