/** Shared claim-ownership fence and trusted reader, independent of reconciliation. */
import { resolve } from 'path';
import { isDeepStrictEqual } from 'node:util';

// One in-process tail shared by binding and branch-reconcile's retirement, so a
// bind cannot land between cleanup's ownership re-read and its removal.
let ownershipTail = Promise.resolve();
export function withClaimOwnershipLock(work) {
  const run = ownershipTail.then(work, work);
  ownershipTail = run.catch(() => {});
  return run;
}

// Checkouts being archived for retirement with the ownership lock released
// (#12682). Every ownership operation queues behind that lock with a 15 s budget,
// so slow archive I/O runs outside it; this fence keeps binds and reconcile
// admissions off the one checkout meanwhile. The removal path still re-reads
// owners and fingerprints under the lock, so the fence adds refusal, never permission.
const retirementFences = new Set();
const fencePath = p => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const fenceBranch = b => (b ? String(b).replace(/^refs\/heads\//, '') : null);

/** `checkout-retirement-reserved` when `branch` or checkout `path` of `repoPath` is fenced. */
export function checkoutRetirementFenceReason({ repoPath, path = null, branch = null }) {
  if (!repoPath) return null;
  const repo = fencePath(repoPath);
  const at = path ? fencePath(path) : null;
  const name = fenceBranch(branch);
  for (const fence of retirementFences) {
    if (fence.repo !== repo) continue;
    if ((at && fence.path === at) || (name && name !== 'HEAD' && fence.branch === name)) return 'checkout-retirement-reserved';
  }
  return null;
}

/**
 * Fence one checkout (or, with no `path`, one checkout-less branch) while it is
 * archived outside the lock. Call while holding
 * `withClaimOwnershipLock`, after the ownership checks pass, and call the returned
 * release under the lock once removal settles (it is idempotent, so a `finally`
 * may repeat it). Returns null when the checkout is already fenced.
 */
export function reserveCheckoutRetirementFence({ repoPath, path, branch = null }) {
  if (checkoutRetirementFenceReason({ repoPath, path, branch })) return null;
  const fence = { repo: fencePath(repoPath), path: path ? fencePath(path) : null, branch: fenceBranch(branch) };
  retirementFences.add(fence);
  return () => { retirementFences.delete(fence); };
}

/**
 * Retire one checkout with its archive between two ownership critical sections.
 * - `admit()` runs under the lock and returns `{ result }` to settle there, or
 *   `{ fence: { repoPath, path, branch }, ... }` to archive. An already-fenced
 *   checkout settles as `busy()`.
 * - `archive(admitted)` runs with the lock released and the fence held, and
 *   returns `{ result }` to stop or `{ archive }` to continue.
 * - `finish(admitted, archive)` runs under the lock again with the fence held;
 *   it must re-prove ownership and the archived bytes before removing anything.
 */
export async function retireWithUnlockedArchive({ admit, archive, finish, busy }) {
  const admitted = await withClaimOwnershipLock(async () => {
    const step = await admit();
    if (!step.fence) return step;
    const release = reserveCheckoutRetirementFence(step.fence);
    return release ? { ...step, release } : { result: busy() };
  });
  if (!admitted.release) return admitted.result;
  try {
    const archived = await archive(admitted);
    if (!('archive' in archived)) return archived.result;
    return await withClaimOwnershipLock(async () => {
      try { return await finish(admitted, archived.archive); }
      finally { admitted.release(); }
    });
  } finally {
    admitted.release();
  }
}

/** Destructive callers must not consume loadState's empty recovery default. */
export async function readClaimOwnershipAgents() {
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const snapshot = await readAgentsStateForSafetyCheck().catch(() => null);
  if (snapshot?.trusted !== true || !snapshot.agents || typeof snapshot.agents !== 'object' || Array.isArray(snapshot.agents)) return null;
  const entries = Object.entries(snapshot.agents);
  const releaseCandidateTransferSchema = entries.some(([, agent]) => agent?.metadata?.releaseCandidateSuccessor
    || agent?.metadata?.releaseCandidateRecovery?.status === 'transferred')
    ? (await import('../lib/releasePublication.js')).releaseCandidateTransferSchema : null;
  if (entries.some(([id, agent]) => {
    if (!agent || agent.id !== id || !['running', 'paused', 'completed'].includes(agent.status)) return true;
    if (agent.metadata != null && (typeof agent.metadata !== 'object' || Array.isArray(agent.metadata))) return true;
    const candidate = agent.metadata?.releaseCandidate;
    if (candidate != null && (candidate.version !== 1 || agent.metadata?.taskAnalysisType !== 'do-release'
      || agent.metadata?.isWorktree !== false || candidate.startedAt !== agent.startedAt
      || candidate.branch !== `codex/release-${id}` || !Number.isFinite(Date.parse(candidate.reservedAt)))) return true;
    const synchronization = agent.metadata?.releaseSynchronizationCheckout;
    if (synchronization != null && (synchronization.version !== 1 || agent.metadata?.taskAnalysisType !== 'do-release'
      || agent.metadata?.isWorktree !== false || synchronization.startedAt !== agent.startedAt
      || !/^[a-f0-9]{64}$/.test(synchronization.identity || '')
      || synchronization.branch !== `codex/release-sync-${synchronization.identity}`
      || synchronization.identity !== agent.metadata?.releasePublication?.identity
      || !Number.isFinite(Date.parse(synchronization.reservedAt)))) return true;
    const recovery = agent.metadata?.releaseCandidateRecovery;
    const transfer = recovery?.status === 'transferred' ? recovery.transfer : agent.metadata?.releaseCandidateSuccessor;
    if (recovery && (recovery.version !== 1 || !['held', 'transferred'].includes(recovery.status)
      || typeof recovery.predecessorAgentId !== 'string')) return true;
    if (transfer) {
      if (!releaseCandidateTransferSchema.safeParse(transfer).success || agent.metadata.taskAnalysisType !== 'do-release'
        || agent.metadata.isWorktree !== false || transfer.source.agentId === transfer.successor.agentId
        || transfer.source.taskId !== transfer.successor.taskId || transfer.branch !== transfer.lineage.receipt.branch
        || transfer.path !== transfer.lineage.receipt.path || transfer.settlement.owner.agentId !== transfer.source.agentId
        || transfer.settlement.owner.taskId !== transfer.source.taskId || transfer.settlement.owner.startedAt !== transfer.source.startedAt) return true;
      const binding = recovery?.status === 'transferred' ? transfer.successor : transfer.source;
      if (binding.agentId !== id || binding.taskId !== agent.taskId || binding.startedAt !== agent.startedAt) return true;
      const predecessor = snapshot.agents[transfer.source.agentId];
      const successor = snapshot.agents[transfer.successor.agentId];
      if (predecessor && successor && (!isDeepStrictEqual(predecessor.metadata?.releaseCandidateSuccessor, transfer)
        || !isDeepStrictEqual(successor.metadata?.releaseCandidateRecovery?.transfer, transfer))) return true;
    } else if (recovery?.status === 'transferred') return true;
    return ['claimBranches', 'claimReleasedBranches'].some(key => {
      const bindings = agent.metadata?.[key] ?? agent[key];
      return bindings != null && (!Array.isArray(bindings) || bindings.some(branch => typeof branch !== 'string'));
    });
  })) return null;
  return entries.map(([, agent]) => agent);
}
