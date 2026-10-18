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
  const holds = describeIdleReconcilePark(result.skipped || [], [], {
    wip: result.wip, detachedWorktrees: result.detachedWorktrees,
    superseded: result.superseded, claimMarkersHeld: result.claimMarkersHeld
  });
  const uncertain = result.forgeUnavailable || result.prStateUnavailable;
  const remaining = (result.inFlight?.length || 0) + (holds.counts?.heldBranches || 0) + (holds.counts?.heldDetached || 0);
  emitLog(uncertain || remaining ? 'warn' : 'info',
    `Branch reconciliation completion: cleaned ${result.cleaned.length}, superseded ${result.reapedSuperseded?.length || 0}, remaining ${remaining}${uncertain ? '; scan incomplete' : ''}`,
    { appId: app.id, analysisType: type, counts: holds.counts, skipCauses: holds.skipCauses });
  return result;
}
