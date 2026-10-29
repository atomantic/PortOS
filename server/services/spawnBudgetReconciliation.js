import { isLeaseLive } from './cosTaskClaim.js';
import { spawnBudgetCount, validSpawnBudgetEpisode } from './spawnBudgetProof.js';

const KEYS = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'];

/** Correct a stopped task only from its own latest server-owned dispatch proof. */
export async function reconcileSpawnBudget(taskId) {
  const [{ getTaskById, updateTask }, { readAgentsStateForSafetyCheck }] = await Promise.all([
    import('./cosTaskStore.js'), import('./cosState.js'),
  ]);
  const task = await getTaskById(taskId);
  const proof = task?.metadata?.spawnBudgetProof;
  if (!task || task.status !== 'blocked' || isLeaseLive(task.metadata)
    || !validSpawnBudgetEpisode(proof) || !proof.dispatch?.agentId) return { reconciled: false, reason: 'episode-unverified' };
  const state = await readAgentsStateForSafetyCheck();
  if (!state.trusted) return { reconciled: false, reason: 'owners-unreadable' };
  const agent = state.agents?.[proof.dispatch.agentId];
  const receipt = agent?.metadata?.completionTaskDispatch;
  if (agent?.status !== 'completed' || agent.id !== proof.dispatch.agentId || !agent.startedAt || agent.taskId !== task.id || receipt?.taskId !== task.id
    || proof.dispatch.startedAt !== agent.startedAt || receipt.spawnBudgetStartedAt !== agent.startedAt
    || receipt.taskType !== (task.taskType || 'user') || receipt.spawnBudgetEpoch !== proof.epoch
    || !Array.isArray(receipt.expected) || receipt.expected.length !== KEYS.length
    || KEYS.some(key => receipt.expected.filter(row => Array.isArray(row) && row.length === 2 && row[0] === key).length !== 1)) {
    return { reconciled: false, reason: 'dispatch-receipt-unverified' };
  }
  const expected = Object.fromEntries(receipt.expected);
  if (KEYS.some(key => key === 'totalSpawnCount'
    ? spawnBudgetCount(expected[key]) === null || spawnBudgetCount(expected[key]) !== spawnBudgetCount(proof.dispatch[key])
    : !expected[key] || expected[key] !== proof.dispatch[key])) return { reconciled: false, reason: 'dispatch-receipt-conflict' };
  const count = spawnBudgetCount(task.metadata.totalSpawnCount);
  const charged = spawnBudgetCount(proof.dispatch.totalSpawnCount);
  if (count === null || charged === null || count > charged) return { reconciled: false, reason: 'counter-conflict' };
  if (count === charged) return { reconciled: false, reason: 'already-reconciled' };
  const saved = await updateTask(task.id, { metadata: { totalSpawnCount: charged, spawnBudgetReconciledHold: 'true' } }, task.taskType || 'user', {
    expectedStatus: 'blocked', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: agent.id, startedAt: agent.startedAt, requireInactive: true },
    spawnBudgetOperation: { kind: 'reconcile' },
  });
  return saved?.error || saved?.statusChanged ? { reconciled: false, reason: 'task-or-owner-changed' }
    : { reconciled: true, count: charged };
}
