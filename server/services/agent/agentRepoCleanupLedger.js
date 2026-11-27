/** Read checkout ownership and record branch-scoped cleanup outcomes. */

import { realpath } from 'node:fs/promises';
import { sameCheckoutPath } from '../../lib/pathContainment.js';
import { readCompletedCheckoutIdentity, shortBranch } from '../completedCheckoutEvidence.js';
import { resolve } from 'path';
import { listWorktrees } from '../worktreeManager.js';
import { readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { claimCheckoutOwner } from '../../lib/claimContinuation.js';

export const canonicalRepository = path => typeof path === 'string' && path ? realpath(path).catch(() => resolve(path)) : Promise.resolve(null);
export const skipped = (skipReason, { issues = [], observed = null } = {}) => ({ verified: false, skipReason, issues, observed, recoveryTaskId: null });

/**
 * The cleanup ledger for one branch. `blockWith` records a hold and returns the
 * matching skip in one step, so a gate cannot return a skip while leaving the
 * ledger silent about the branch it held. `skipReason` overrides the returned
 * reason only where the caller-facing skip code differs from the ledger reason.
 *
 * @param {string} agentId
 * @param {{branch: string, path?: string}} location - stamped on every ledger entry
 */
export function branchLedger(agentId, location, recordCleanup) {
  const record = async (status, reason, extra = {}) => {
    if (recordCleanup) return recordCleanup({ status, reason, ...location, ...extra });
    const { recordCleanupOutcome } = await import('../cos/cosAgentLifecycle.js');
    return recordCleanupOutcome(agentId, { status, reason, ...location, ...extra });
  };
  const blockWith = async (reason, { skipReason = reason, record: extra, issues, observed } = {}) => {
    await record('blocked', reason, extra);
    return skipped(skipReason, { issues, observed });
  };
  return { record, blockWith };
}

/**
 * A reused branch is not the old checkout. No model is needed to identify a
 * different holder, and its live work must never become this parent's target.
 *
 * @returns {Promise<{reason: string, record?: object}|null>} the hold, or null when this run still owns the checkout
 */
export async function resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath }) {
  const inventory = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!inventory) return { reason: 'checkout-inventory-unavailable' };
  const holders = inventory.filter(tree => shortBranch(tree.branch) === branchName);
  // Git porcelain uses forward slashes on Windows; registration spelling is
  // not a checkout change. Compare native lexical paths and the recorded head.
  const samePath = tree => sameCheckoutPath(tree.path, worktreePath);
  const pathHolder = inventory.find(samePath);
  if (holders.some(tree => !samePath(tree))
    || (pathHolder && shortBranch(pathHolder.branch) !== branchName)) {
    return { reason: 'checkout-changed' };
  }
  if (pathHolder && typeof worktreePath === 'string' && worktreePath) {
    const completed = metadata.completedCheckouts?.find(row => row?.branch === branchName && sameCheckoutPath(row.path, worktreePath));
    if (completed) {
      const identity = await readCompletedCheckoutIdentity({ repoPath: sourceWorkspace, branch: branchName,
        path: worktreePath, head: pathHolder.head }).catch(() => null);
      if (!identity || identity.head !== completed.head) {
        return { reason: 'checkout-changed' };
      }
    }
  }
  const owner = claimCheckoutOwner({ branchName, sourceWorkspace,
    agents: await readClaimOwnershipAgents().catch(() => null),
    ignoreIds: agentId ? [agentId] : [] });
  return owner ? { reason: owner.reason, record: { owners: owner.owners } } : null;
}
