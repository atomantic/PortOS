/** Shared claim-ownership lock and trusted reader, independent of reconciliation. */
import { isDeepStrictEqual } from 'node:util';

// One in-process tail shared by binding and every checkout retirement. A removal
// re-reads owners, re-verifies the checkout and removes it inside one section, so
// a bind lands before that re-read or after the removal, never between them.
// Every bind/release/reserve queues here on a short budget, so resolve a fetch
// or other slow read before entering a section (#12764).
let ownershipTail = Promise.resolve();
export function withClaimOwnershipLock(work) {
  const run = ownershipTail.then(work, work);
  ownershipTail = run.catch(() => {});
  return run;
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
