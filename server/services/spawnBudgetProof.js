import { randomUUID } from 'node:crypto';

// Per-run dispatch accounting. A new task carrying any of these is not a fresh
// episode, so addTask grants it no spawn-budget proof and dispatch holds it.
export const SPAWN_HISTORY_METADATA_KEYS = Object.freeze(['totalSpawnCount', 'lastSpawnedAt', 'claimedBy', 'claimedAt',
  'failureCount', 'orphanRetryCount', 'lastAgentId', 'failedAgentId', 'deliveryDecisionAgentId']);

// Only a newly created task or a budget reset can start a known episode.
export const newSpawnBudgetEpisode = (baseline = 0) => ({ version: 1, epoch: randomUUID(), baseline, dispatch: null, history: [] });

export function validSpawnBudgetEpisode(value) {
  if (value?.version !== 1 || typeof value.epoch !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.epoch)
    || (value.history !== undefined && !Array.isArray(value.history))) return false;
  const history = value.history || [];
  if (spawnBudgetCount(value.baseline ?? 0) === null || history.length > 128 || (value.dispatch === null && history.length)) return false;
  const entries = [...history, ...(value.dispatch === null ? [] : [value.dispatch])];
  return entries.every((entry, index) => entry && ['agentId', 'claimedBy', 'claimedAt', 'lastSpawnedAt']
    .every(key => typeof entry[key] === 'string' && entry[key].length > 0)
    && ((typeof entry.startedAt === 'string' && entry.startedAt.length > 0)
      || (typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt)))
    && spawnBudgetCount(entry.totalSpawnCount) !== null
    && spawnBudgetCount(entry.totalSpawnCount) === (index
      ? spawnBudgetCount(entries[index - 1].totalSpawnCount) : spawnBudgetCount(value.baseline ?? 0)) + 1);
}

export function spawnBudgetCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Exact identity and latest high-water receipt; does not imply inactive ownership. */
export function matchesSpawnBudgetProof(task, agent) {
  const proof = task?.metadata?.spawnBudgetProof;
  const receipt = agent?.metadata?.completionTaskDispatch;
  const keys = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'];
  if (!validSpawnBudgetEpisode(proof) || !proof.dispatch || proof.dispatch.agentId !== agent?.id
    || proof.dispatch.startedAt !== agent?.startedAt || receipt?.spawnBudgetStartedAt !== agent?.startedAt
    || receipt?.taskId !== task.id || agent.taskId !== task.id || receipt.taskType !== (task.taskType || 'user')
    || receipt.spawnBudgetEpoch !== proof.epoch || !Array.isArray(receipt.expected) || receipt.expected.length !== keys.length
    || keys.some(key => receipt.expected.filter(row => Array.isArray(row) && row.length === 2 && row[0] === key).length !== 1)) return false;
  const expected = Object.fromEntries(receipt.expected);
  return keys.every(key => key === 'totalSpawnCount'
    ? spawnBudgetCount(expected[key]) !== null && spawnBudgetCount(expected[key]) === spawnBudgetCount(proof.dispatch[key])
    : !!expected[key] && expected[key] === proof.dispatch[key]);
}

/** Explain why a persisted task cannot be automatically dispatched. */
export async function spawnBudgetHoldReason(task) {
  const metadata = task?.metadata || {};
  const proof = metadata.spawnBudgetProof;
  if (!validSpawnBudgetEpisode(proof) || metadata.spawnBudgetReconciledHold === 'true') return 'Spawn budget history is unverified or held';
  if (!proof.dispatch) return spawnBudgetCount(metadata.totalSpawnCount ?? 0) === spawnBudgetCount(proof.baseline ?? 0)
    ? null : 'Spawn budget history is unverified or held';
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const state = await readAgentsStateForSafetyCheck().catch(() => null);
  const owner = state?.trusted ? state.agents?.[proof.dispatch.agentId] : null;
  return owner?.status === 'completed' && matchesSpawnBudgetProof(task, owner)
    && spawnBudgetCount(metadata.totalSpawnCount) !== null
    && spawnBudgetCount(metadata.totalSpawnCount) === spawnBudgetCount(proof.dispatch.totalSpawnCount)
    ? null : 'Spawn budget history is unverified or held';
}
