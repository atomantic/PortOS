/** Shared claim-ownership fence and trusted reader, independent of reconciliation. */
// One in-process tail shared by binding and branch-reconcile's retirement, so a
// bind cannot land between cleanup's ownership re-read and its removal.
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
  if (entries.some(([id, agent]) => {
    if (!agent || agent.id !== id || !['running', 'paused', 'completed'].includes(agent.status)) return true;
    if (agent.metadata != null && (typeof agent.metadata !== 'object' || Array.isArray(agent.metadata))) return true;
    return ['claimBranches', 'claimReleasedBranches'].some(key => {
      const bindings = agent.metadata?.[key] ?? agent[key];
      return bindings != null && (!Array.isArray(bindings) || bindings.some(branch => typeof branch !== 'string'));
    });
  })) return null;
  return entries.map(([, agent]) => agent);
}
