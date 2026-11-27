/** Verify and settle absent checkouts using registered scopes, current inventory and delivery evidence. */

import { sameCheckoutPath } from '../../lib/pathContainment.js';
import { shortBranch, findValidCheckoutCaptures } from '../completedCheckoutEvidence.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from '../repoCleanupObservation.js';
import { resolve } from 'path';
import { getDefaultBranch } from '../git/status.js';
import { listWorktrees } from '../worktreeManager.js';
import { execGit } from '../../lib/execGit.js';
import { resolveTaskTargetBranch } from '../../lib/taskTargetBranch.js';
import { probePrForBranch } from '../prProbe.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { canonicalRepository, skipped, branchLedger, resolveCheckoutHold } from './agentRepoCleanupLedger.js';

/** Physical cleanup uses the registered checkout scope, including legacy records
 * that predate the current snapshot fields. */
export function recordedCheckoutScope(agent) {
  const meta = agent?.metadata;
  if (![meta?.sourceWorkspace, meta?.workspacePath, meta?.worktreeBranch].every(value => typeof value === 'string' && value)
    || resolve(meta.sourceWorkspace) === resolve(meta.workspacePath)) return null;
  return { repoPath: meta.sourceWorkspace, path: meta.workspacePath, branch: meta.worktreeBranch };
}

export function pendingCheckoutScope(agent) {
  return agent.status === 'completed' && agent.metadata?.checkoutCapture?.status === 'pending'
    && agent.metadata.checkoutCapture.unknown === true && agent.metadata.completionCleanup?.status === 'pending'
    ? recordedCheckoutScope(agent) : null;
}

export async function pendingCheckoutAbsent(agent) {
  const scope = pendingCheckoutScope(agent);
  if (!scope) return false;
  const worktrees = await listWorktrees(scope.repoPath).catch(() => null);
  return !!worktrees && await readCheckoutPathPresence(scope.path) === false
    && await readLocalBranchPresence(scope.repoPath, scope.branch) === false
    && !worktrees.some(row => resolve(row.path) === resolve(scope.path) || shortBranch(row.branch) === scope.branch);
}

/** A cleanup run whose task moved to another owner owes only its own checkout's
 * physical cleanup; the current owner verifies delivery. The writer settles it
 * only once that move is final. */
export function handedOffRetirementScope(agent) {
  const meta = agent?.metadata;
  if (agent?.status !== 'completed' || agent.result?.cleanupPending !== true || meta?.isWorktree !== true
    || meta.checkoutCapture?.status !== 'captured' || meta.completionCleanup?.status !== 'pending'
    || ![meta.sourceWorkspace, meta.workspacePath, meta.worktreeBranch].every(value => typeof value === 'string' && value)) return null;
  const captured = (meta.completedCheckouts || []).filter(row => row?.branch === meta.worktreeBranch
    && typeof row.path === 'string' && row.path).map(row => row.path);
  return { repoPath: meta.sourceWorkspace, branch: meta.worktreeBranch, paths: [...new Set([meta.workspacePath, ...captured])] };
}

/** Settle physical cleanup once every checkout path, the local branch and any
 * worktree entry are gone and no live run owns the branch. The execution result
 * is never changed. */
export async function settleAbsentScope(agent, { repoPath, branch, paths }, proof = {}) {
  return withClaimOwnershipLock(async () => {
    const { recordAbsentCheckoutRetirement } = await import('../cos/cosAgentLifecycle.js');
    const owners = await readClaimOwnershipAgents().catch(() => null);
    if (!owners || owners.some(owner => ['running', 'paused'].includes(owner.status)
      && resolve(owner.metadata?.sourceWorkspace || owner.metadata?.workspacePath || '') === resolve(repoPath)
      && (resolveTaskTargetBranch(owner.metadata) === branch || owner.metadata?.worktreeBranch === branch
        || owner.metadata?.claimBranches?.includes(branch)))) return false;
    const worktrees = await listWorktrees(repoPath).catch(() => null);
    if (!worktrees) return false;
    for (const path of paths) if (await readCheckoutPathPresence(path) !== false) return false;
    if (await readLocalBranchPresence(repoPath, branch) !== false
      || worktrees.some(row => paths.some(path => sameCheckoutPath(row.path, path)) || shortBranch(row.branch) === branch)) return false;
    return recordAbsentCheckoutRetirement(agent.id, agent, { path: paths[0], branch, ...proof });
  });
}

// Repair only the obsolete path-specific hold behind an already verified
// released selection. This does not reopen tasks, retry delivery or remove data.
export async function settleReleasedSelectionHistory(agentId, metadata, branch, trees) {
  const held = Object.values(metadata.cleanupOutcomes || {}).filter(row => row.branch === branch && row.status !== 'verified' && row.path != null);
  for (const row of held) {
    if (row.reason !== 'absent-checkout-integration-unverified' || typeof row.path !== 'string'
      || trees.some(tree => resolve(tree.path) === resolve(row.path))
      || await readCheckoutPathPresence(row.path).catch(() => null) !== false) return false;
  }
  for (const row of held) await branchLedger(agentId, { branch, path: row.path })
    .record('verified', 'released-selection-no-local-artifacts');
  return true;
}

async function containedInDefaultBranch(sourceWorkspace, head) {
  const branch = await getDefaultBranch(sourceWorkspace, { allowRemote: false, strict: true }).catch(() => null);
  if (!branch) return false;
  const result = await execGit(['merge-base', '--is-ancestor', head, `refs/remotes/origin/${branch}`], sourceWorkspace,
    { ignoreExitCode: true, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } }).catch(() => null);
  return result?.exitCode === 0;
}

/** Already removed checkouts need delivery proof, not a retroactive backup. */
export async function settleAbsentCheckout({ agentId, agentState, metadata, app, sourceWorkspace, branchName, worktreePath, originalPrUrl, observed, record, staysOpen, recheckCleanup }) {
  const { readMergedPrDelivery } = await import('../mergedPrEvidence.js');
  const repository = await canonicalRepository(sourceWorkspace);
  // Opening a PR need not have been requested by the original task. A run
  // can nevertheless have delivered one itself. Its immutable capture permits
  // a read-only merge lookup; it never authorizes removal or a made-up receipt.
  const captures = agentState?.status === 'completed'
    ? findValidCheckoutCaptures(agentState, { branch: branchName, repoPath: repository, path: worktreePath })
    : [];
  const capturedHead = captures.length === 1 ? captures[0].head : null;
  const delivery = capturedHead && !originalPrUrl && !observed.prState
    ? await probePrForBranch(sourceWorkspace, branchName).catch(() => null) : observed;
  const proofUrl = originalPrUrl || delivery?.prUrl;
  let forgeRefusal = null;
  const forge = proofUrl && delivery?.prState === 'MERGED' ? await readMergedPrDelivery(sourceWorkspace, branchName, proofUrl,
    { forgeAccount: app?.forgeAccount ?? null, ...(capturedHead && { exactDeliveredHead: capturedHead }) })
    .catch(err => { forgeRefusal = err?.message; return null; }) : null;
  // The forge binds merged delivery to this repository and named PR branch.
  // A follow-up may rebase or advance its head after the original capture.
  // With the checkout and local ref already absent, there is nothing to remove
  // or preserve; a historical retirement receipt cannot add delivery evidence.
  // An inferred branch lookup has no original PR identity. In that case only
  // exact/ancestor delivery links its capture to the PR we found.
  const integrated = !!forge && (!!originalPrUrl || !capturedHead || forge.prHead === capturedHead
    || (forge.scopeProof === 'ancestor-of-delivered-head' && forge.deliveredAncestorHead === capturedHead));
  // A run that never published (a no-change audit) has no PR to prove. When the
  // forge affirmatively reports none, no remote branch holds other work, and the
  // captured final head is already in the fetched default branch, the removed
  // checkout held nothing undelivered.
  // A merged contributor-fork PR is refused by the same-repository helper
  // ('merged-pr-not-matching'); the forge still reports it MERGED, so the
  // captured head's ancestry in the fetched default branch proves delivery.
  const noPrToProve = !proofUrl && delivery?.readable === true && !delivery.prState;
  // Only the task's own recorded PR identity qualifies: a PR inferred from a
  // branch-name probe could be unrelated, so ancestry alone must not settle it.
  const mergedForkPr = !!originalPrUrl && delivery?.prState === 'MERGED' && forgeRefusal === 'merged-pr-not-matching';
  const unpublishedContained = !integrated && capturedHead && (noPrToProve || mergedForkPr)
    && observed.remoteBranchPresent === false && await containedInDefaultBranch(sourceWorkspace, capturedHead);
  if (!staysOpen && integrated && observed.remoteBranchPresent !== false) {
    const reason = observed.remoteBranchPresent === true ? 'remote-branch-present' : 'remote-branch-unverified';
    await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: true });
    return skipped(reason);
  }
  if (!staysOpen && (integrated || unpublishedContained)) {
    const verified = await withClaimOwnershipLock(async () => {
      await recheckCleanup?.();
      if (await resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath })
        || (worktreePath && await readCheckoutPathPresence(worktreePath) !== false)
        || await readLocalBranchPresence(sourceWorkspace, branchName) !== false) return false;
      return await (integrated
        ? record('verified', 'already-absent-merged', { prUrl: proofUrl, committedIntegrationVerified: true })
        : record('verified', 'already-absent-integrated', { committedIntegrationVerified: true })) === true;
    }).catch(() => false);
    if (verified) return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
    const reason = 'absent-checkout-settlement-unverified';
    await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: true });
    return skipped(reason);
  }
  const reason = 'absent-checkout-integration-unverified';
  await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: !!integrated });
  return skipped(reason);
}
