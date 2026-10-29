import { validSpawnBudgetEpisode } from './spawnBudgetProof.js';

/** Crash-safe task handoff inside the original completion receipt. No branch discovery. */
const DISPATCH_KEYS = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'];
const VERSION_KEYS = [...DISPATCH_KEYS, 'updatedAt', 'deliveryRecovery', 'deliveryRecoveryAgentId'];
const entries = (metadata, keys) => keys.map(key => [key, metadata?.[key] ?? null]);
// Task persistence round-trips scalar metadata through the markdown contract;
// dispatch sees a number, while a later read (or a legacy receipt) sees text.
const spawnCount = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
};
const matches = (metadata, expected) => expected.every(([key, value]) => key === 'totalSpawnCount'
  ? spawnCount(value) !== null && spawnCount(metadata?.[key]) === spawnCount(value)
  : (metadata?.[key] ?? null) === value);

/** Match the server's dispatch binding, including metadata scalar round-trips. */
export function matchesCompletionTaskDispatch(agent, task) {
  const binding = agent?.metadata?.completionTaskDispatch;
  return !!binding && binding.taskId === task?.id && binding.taskId === agent.taskId
    && binding.taskType === (task.taskType || 'user') && Array.isArray(binding.expected)
    && binding.expected.length === DISPATCH_KEYS.length
    && DISPATCH_KEYS.every(key => binding.expected.filter(row => Array.isArray(row) && row.length === 2 && row[0] === key).length === 1)
    && matches(task.metadata, binding.expected);
}

/** Called by the trusted dispatcher after its task write, before provider launch. */
export async function bindCompletionTaskDispatch(agentId, task) {
  if (task?.status !== 'in_progress' || !task.metadata?.lastSpawnedAt || !task.metadata?.claimedBy
    || spawnCount(task.metadata.totalSpawnCount) === null) return false;
  const { updateAgent } = await import('./cosAgentLifecycle.js');
  const proof = task.metadata.spawnBudgetProof;
  return !!await updateAgent(agentId, { metadata: { completionTaskDispatch: {
    taskId: task.id, taskType: task.taskType || 'user', expected: entries(task.metadata, DISPATCH_KEYS),
    ...(validSpawnBudgetEpisode(proof) && proof.dispatch?.agentId === agentId
      ? { spawnBudgetEpoch: proof.epoch, spawnBudgetStartedAt: proof.dispatch.startedAt } : {}),
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
    expectedMetadata: Object.fromEntries(intent.expected.map(([key]) => [key, current.metadata?.[key]])) });
  return saved?.error || saved?.statusChanged ? null : saved;
}
