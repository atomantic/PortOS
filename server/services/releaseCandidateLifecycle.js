/** Service-observed candidate milestones. A registered record proves only that
 * no reservation was observed: the agent can execute Git independently, so it
 * is never evidence that a candidate does not exist. Legacy runs have no record. */
export function initialCandidateLifecycle(agent) {
  return { version: 1, agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt, stage: 'registered' };
}

export function advanceCandidateLifecycle(agent, stage, candidate) {
  const prior = agent.metadata.releaseCandidateLifecycle;
  if (prior == null) return null; // Do not manufacture provenance for legacy runs.
  if (prior.version !== 1 || prior.agentId !== agent.id || prior.taskId !== agent.taskId
    || prior.startedAt !== agent.startedAt || !['registered', 'reserved', 'captured'].includes(prior.stage)
    || (prior.stage !== 'registered' && (prior.branch !== candidate.branch || prior.reservedAt !== candidate.reservedAt))
    || (stage === 'reserved' && prior.stage !== 'registered')
    || (stage === 'captured' && !['reserved', 'captured'].includes(prior.stage))) {
    throw new Error('candidate-lifecycle-conflict');
  }
  if (stage === 'reserved') return { ...prior, stage, branch: candidate.branch, reservedAt: candidate.reservedAt };
  return prior.stage === 'captured' ? prior : { ...prior, stage, capturedAt: new Date().toISOString() };
}
