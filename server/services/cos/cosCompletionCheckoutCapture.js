/** Capture completed checkout identities and recover interrupted captures for the original agent generation. */
import { realpath } from 'fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { hasClaimCheckoutBindings, hasReleaseCandidateBinding, readCompletedCheckoutIdentity, readMergedClaimEvidence, captureCompletedCheckouts } from '../completedCheckoutEvidence.js';
import { cosEvents } from './cosEvents.js';
import { getAgentRecord } from './cosAgentRecord.js';
import { updateCompletionReceipt } from './cosCompletionReceipts.js';

export async function captureAgentCompletionCheckouts(agent) {
  if (!(hasClaimCheckoutBindings(agent.metadata) || hasReleaseCandidateBinding(agent.metadata) || agent.metadata?.isWorktree)) return {};
  // Failed and orphaned runs may already have delivered code.
  try {
    return { completedCheckouts: await captureCompletedCheckouts(agent, { success: true, strict: true }) };
  } catch (error) {
    // Ingestion remains terminal. Only captured targets can be retried.
    return {
      completedCheckouts: [],
      checkoutCapture: { status: 'pending', reason: 'checkout-evidence-unavailable',
        targets: error.checkoutCapture?.targets || [], unknown: error.checkoutCapture?.unknown !== false,
        observedAt: new Date().toISOString() },
    };
  }
}

/** Recover an unknown capture from the run's still-bound delivery and fresh
 * merge proof. Checkout generations and legacy seeds do not grant authority. */
async function resolveMergedCompletionSnapshot(agentId) {
  const agent = await getAgentRecord(agentId);
  const meta = agent?.metadata;
  if (agent?.status !== 'completed' || agent.result?.executionSuccess !== true
    || agent.result.validationPassed === false || meta?.blocker || agent.result.taskOutcome?.recovery?.mode === 'approval'
    || meta?.checkoutCapture?.status !== 'pending' || meta.checkoutCapture.unknown !== true) return null;
  const metadata = structuredClone(meta);
  const repoPath = meta.sourceWorkspace || meta.workspacePath;
  const branches = hasClaimCheckoutBindings(meta) ? meta.claimBranches : [meta.worktreeBranch];
  if (!repoPath || branches?.length !== 1 || !branches[0]) return null;
  const branch = branches[0];
  const { listWorktrees } = await import('../worktreeManager.js');
  const trees = await listWorktrees(repoPath).catch(() => null);
  const holders = trees?.filter(tree => tree.branch?.replace(/^refs\/heads\//, '') === branch);
  if (holders?.length !== 1 || holders[0].locked) return null;
  const path = holders[0].path;
  const matchesPath = async value => await realpath(value || '').catch(() => null) === await realpath(path);
  const claim = meta.configClaimFlow === true && hasClaimCheckoutBindings(meta);
  const inline = meta.prOpenedBy === 'agent-inline' && meta.configOpenPR === true
    && meta.prDeliveryTarget?.branch === branch && await matchesPath(meta.prDeliveryTarget.workspacePath);
  const review = meta.prCompletionPolicy === 'review-then-merge' && meta.reviewLoopMergeTarget?.branch === branch
    && await matchesPath(meta.workspacePath);
  if (!claim && !inline && !review) return null;
  const current = await readCompletedCheckoutIdentity({ repoPath, branch, path, head: holders[0].head }).catch(() => null);
  if (!current) return null;
  const proof = await readMergedClaimEvidence(current).catch(() => null);
  const knownPr = meta.branchCompletionPolicy?.prUrl || meta.reviewLoopMergeTarget?.url;
  if (!proof || (knownPr && knownPr !== proof.prUrl)) return null;
  return { metadata, snapshot: { version: 2, agentId, startedAt: agent.startedAt, capturedAt: new Date().toISOString(),
    repoPath: current.repoPath, branch, path: current.path, head: current.head } };
}

/** True when another record on this branch and repository is not strictly earlier than this generation. */
async function hasCompetingGenerationOnBranch(history, agentId, startedAt, target) {
  for (const other of history) {
    if ((other.id || other.agentId) === agentId) continue;
    const meta = other.metadata || {};
    const branches = [meta.worktreeBranch, ...(meta.claimBranches || []), ...(meta.claimReleasedBranches || [])];
    if (!branches.includes(target.branch)) continue;
    const repository = await realpath(meta.sourceWorkspace || meta.workspacePath || '').catch(() => null);
    if (repository !== target.repoPath) continue;
    if (!Number.isFinite(Date.parse(other.startedAt)) || Date.parse(other.startedAt) >= Date.parse(startedAt)) return true;
  }
  return false;
}

/** A pre-terminal capture snapshot must lie inside the run and still match the physical checkout. */
async function capturedSnapshotIsCurrent(agent, target, { late = false } = {}) {
  if (!Number.isFinite(Date.parse(target.capturedAt)) || Date.parse(target.capturedAt) < Date.parse(agent.startedAt)
    || (!late && Date.parse(target.capturedAt) > Date.parse(agent.completedAt))) return false;
  const current = await readCompletedCheckoutIdentity(target).catch(() => null);
  const expected = { repoPath: target.repoPath, branch: target.branch, path: target.path, head: target.head };
  return Boolean(current) && isDeepStrictEqual({ repoPath: current.repoPath, branch: current.branch, path: current.path, head: current.head }, expected);
}

/** Every target must belong to this generation: same agent, no later owner, no competing generation, current snapshot. */
async function targetsOwnedByThisGeneration({ agent, agentId, targets, owners, history, late = false }) {
  const { claimCheckoutOwner } = await import('../../lib/claimContinuation.js');
  for (const target of targets) {
    if (target.agentId !== agentId || target.startedAt !== agent.startedAt
      || claimCheckoutOwner({ branchName: target.branch, holderPath: target.path, sourceWorkspace: target.repoPath, agents: owners })) return false;
    if (await hasCompetingGenerationOnBranch(history, agentId, agent.startedAt, target)) return false;
    if (!await capturedSnapshotIsCurrent(agent, target, { late })) return false;
  }
  return true;
}

/** Retry only terminal targets already observed by this run, preserving live owner checks. */
export async function retryCompletionCheckoutCapture(agentId, { retirement } = {}) {
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const mergedSnapshot = await resolveMergedCompletionSnapshot(agentId);
  const recovered = await withClaimOwnershipLock(async () => {
    const agent = await getAgentRecord(agentId);
    const pending = agent?.metadata?.checkoutCapture;
    if (agent?.status !== 'completed' || pending?.status !== 'pending') return false;
    const owners = await readClaimOwnershipAgents().catch(() => null);
    const { readBranchCompletionPolicies } = await import('../branchCompletionPolicy.js');
    const history = await readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
    if (!Array.isArray(owners) || !Array.isArray(history)) return false;
    const targets = pending.unknown === false ? pending.targets
      : mergedSnapshot?.snapshot.startedAt === agent.startedAt && isDeepStrictEqual(mergedSnapshot.metadata, agent.metadata)
        ? [mergedSnapshot.snapshot] : null;
    if (!targets?.length) return false;
    if (!await targetsOwnedByThisGeneration({ agent, agentId, targets, owners, history, late: pending.unknown === true })) return false;
    const captured = targets;
    if (retirement && !captured.some(row => row.repoPath === retirement.repoPath && row.branch === retirement.branch
      && row.path === retirement.path && row.head === retirement.head)) return false;
    let recorded = false;
    const saved = await updateCompletionReceipt(agentId, (metadata, current) => {
      if (current.startedAt !== agent.startedAt || JSON.stringify(metadata.checkoutCapture) !== JSON.stringify(pending)) return metadata;
      recorded = true;
      return { ...metadata, checkoutCapture: { status: 'captured', retriedAt: new Date().toISOString() }, completedCheckouts: captured };
    });
    return saved && recorded;
  });
  // Publish after releasing the ownership lock: the existing completion replay
  // acquires that same lock and must not wait on its own capture operation.
  if (recovered) cosEvents.emit('agent:checkout-captured', { agentId });
  return recovered;
}
