import { ServerError } from '../lib/errorHandler.js';
import { getAppById } from './apps.js';
import { getActiveAgentIds } from './agentState.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile, buildActiveOwnerIds, describeIdleReconcilePark } from './branchReconcile.js';
import { recordBranchReconcileOutcome, getBranchReconcileInventory } from './branchReconcileOutcome.js';
import { cosEvents } from './cosEvents.js';

/** Refresh evidence only: no cleanup, provider dispatch, or delivery recovery. */
export async function refreshBranchReconcileInventory(appId) {
  const app = await getAppById(appId);
  if (!app?.repoPath) throw new ServerError('Managed repository not found', { status: 404, code: 'NOT_FOUND' });
  const agents = await readClaimOwnershipAgents();
  if (!Array.isArray(agents)) throw new ServerError('Repository ownership state unavailable', { status: 503 });
  const result = await reconcile(app.repoPath, {
    appId, cleanup: false, reapSuperseded: false, reapRemotes: false,
    activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds()), agents),
    claimOwners: { agents, readAgents: readClaimOwnershipAgents },
    forgeAccount: app.forgeAccount || null,
  });
  // An unreadable scan must not replace the last inventory with a false zero.
  if (result.forgeUnavailable || result.prStateUnavailable || result.worktreeInventory == null || result.orphanRemotes?.remoteUnavailable) {
    throw new ServerError('Repository scan unavailable; previous inventory retained. Try refreshing again.', { status: 503, code: 'RECONCILE_SCAN_UNAVAILABLE' });
  }
  const inventory = describeIdleReconcilePark([
    ...(result.skipped || []),
    ...(result.inFlight || []).map(row => ({ ...row, reason: 'actionable' })),
  ], [], {
    wip: result.wip, detachedWorktrees: result.detachedWorktrees,
    superseded: result.superseded, claimMarkersHeld: result.claimMarkersHeld,
    worktreeInventory: result.worktreeInventory,
  });
  await recordBranchReconcileOutcome(appId, {
    status: inventory.remaining.length ? 'incomplete' : 'drained',
    reason: inventory.reason, remaining: inventory.remaining,
    remoteInventory: result.orphanRemotes ?? { reaped: [], reported: [] },
    nextAction: inventory.remaining.length ? 'Resolve the listed local holds, then refresh inventory.' : null,
  });
  const outcome = await getBranchReconcileInventory(appId);
  cosEvents.emit('schedule:changed', { taskType: 'branch-reconcile', appId });
  return { appId, outcome };
}
