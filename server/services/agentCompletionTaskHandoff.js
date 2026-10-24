/** Crash-safe task handoff inside the original completion receipt. No branch discovery. */
const DISPATCH_KEYS = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'];
const VERSION_KEYS = [...DISPATCH_KEYS, 'updatedAt', 'deliveryRecovery', 'deliveryRecoveryAgentId'];
const entries = (metadata, keys) => keys.map(key => [key, metadata?.[key] ?? null]);
const matches = (metadata, expected) => expected.every(([key, value]) => (metadata?.[key] ?? null) === value);

/** Called by the trusted dispatcher after its task write, before provider launch. */
export async function bindCompletionTaskDispatch(agentId, task) {
  if (task?.status !== 'in_progress' || !task.metadata?.lastSpawnedAt || !task.metadata?.claimedBy
    || !Number.isInteger(task.metadata.totalSpawnCount)) return false;
  const { updateAgent } = await import('./cosAgentLifecycle.js');
  return !!await updateAgent(agentId, { metadata: { completionTaskDispatch: {
    taskId: task.id, taskType: task.taskType || 'user', expected: entries(task.metadata, DISPATCH_KEYS),
  } } });
}

/** Persist BEFORE terminal agent publication; the two stores are not atomic. */
export async function prepareCompletionTaskHandoff(agent, metadataPatch = {}) {
  const binding = agent?.metadata?.completionTaskDispatch;
  if (!binding || binding.taskId !== agent.taskId || agent.status !== 'running') return false;
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(agent.taskId);
  if (task?.status !== 'in_progress' || (task.taskType || 'user') !== binding.taskType || !matches(task.metadata, binding.expected)) return false;
  const { updateAgent } = await import('./cosAgentLifecycle.js');
  const saved = await updateAgent(agent.id, { metadata: { completionCleanup: { ...agent.metadata.completionCleanup, taskHandoff: {
    version: 1, taskId: task.id, taskType: task.taskType || 'user', startedAt: agent.startedAt,
    expected: entries(task.metadata, VERSION_KEYS),
    metadataPatch: Object.entries(metadataPatch).filter(([key]) => !VERSION_KEYS.includes(key))
      .map(([key, value]) => value === undefined ? { key, remove: true } : { key, value }),
  } } } });
  return saved?.status === 'running';
}

/** Replay only the missing task write, never finalization/hooks or another owner's work. */
export async function recoverCompletionTaskHandoff(agent) {
  const { getTaskById, updateTask } = await import('./cosTaskStore.js');
  const current = await getTaskById(agent.taskId);
  if (current?.status === 'in_progress' && current.metadata?.deliveryRecovery === 'cleanup'
    && current.metadata.deliveryRecoveryAgentId === agent.id) return current;
  const intent = agent.metadata?.completionCleanup?.taskHandoff;
  if (!agent.result?.cleanupPending || intent?.version !== 1 || intent.taskId !== agent.taskId
    || intent.startedAt !== agent.startedAt || current?.status !== 'in_progress'
    || !matches(current.metadata, intent.expected)) return null;
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const owners = await readAgentsStateForSafetyCheck();
  if (!owners.trusted || Object.values(owners.agents).some(owner => owner.id !== agent.id
    && owner.taskId === agent.taskId && owner.status === 'running')) return null;
  const { activeAgents, runnerAgents } = await import('./agentState.js');
  for (const map of [activeAgents, runnerAgents]) {
    if ([...map].some(([id, owner]) => id !== agent.id && (owner.taskId || owner.task?.id) === agent.taskId)) return null;
  }
  const saved = await updateTask(current.id, { status: 'in_progress', metadata: {
    ...Object.fromEntries((intent.metadataPatch || []).map(({ key, value, remove }) => [key, remove ? undefined : value])),
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agent.id, taskOutcome: agent.result.taskOutcome,
  } }, intent.taskType, { expectedStatus: 'in_progress',
    expectedMetadata: Object.fromEntries(intent.expected.map(([key, value]) => [key, value ?? undefined])) });
  return saved?.error || saved?.statusChanged ? null : saved;
}
