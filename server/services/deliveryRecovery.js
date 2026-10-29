import { normalizeTaskOutcome } from '../lib/agentOutcome.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
import { resolveUndeliveredTaskUpdate } from './agentErrorAnalysis.js';
import { matchesSpawnBudgetProof, spawnBudgetCount } from './spawnBudgetProof.js';

/** Adopt old outcome blocks once, retaining the original task, budget and checkout.
 * Manual holds, provider safety refusals and live owners are never revived here.
 */
export async function recoverLegacyDeliveryBlocks(agents, deps = {}) {
  const readTasks = deps.readTasks || (await import('./investigationTaskProducer.js')).readAllTasksFlat;
  const update = deps.update || (await import('./cosTaskStore.js')).updateTask;
  const release = deps.release || (await import('./agentWorktreeCleanup.js')).releaseRetryHold;
  const tasks = await readTasks();
  let recovered = 0;
  for (const task of tasks) {
    if (recovered >= 3) break;
    if (task.status !== 'blocked' || task.metadata?.spawnBudgetReconciledHold === 'true' || !['task-blocked', 'task-incomplete'].includes(task.metadata?.blockedCategory)
      || task.metadata?.legacyDeliveryRecovery || task.metadata?.blocker || isPrivateSecurityTask(task)) continue;
    const outcome = normalizeTaskOutcome(task.metadata.taskOutcome);
    if (!outcome || !['blocked', 'incomplete'].includes(outcome.status)) continue;
    const owners = agents.filter(agent => agent.taskId === task.id);
    if (owners.some(agent => ['running', 'paused'].includes(agent.status))) continue;
    const owner = owners.filter(agent => agent.status === 'completed')
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))[0];
    if (!owner?.id || owner.result?.taskOutcome?.reason !== outcome.reason
      || owner.result?.taskOutcome?.status !== outcome.status || owner.metadata?.executionInterruption || owner.result?.executionInterruption
      || isPrivateSecurityTask(owner) || !matchesSpawnBudgetProof(task, owner)
      || spawnBudgetCount(task.metadata.totalSpawnCount) === null
      || spawnBudgetCount(task.metadata.totalSpawnCount) !== spawnBudgetCount(task.metadata.spawnBudgetProof.dispatch.totalSpawnCount)) continue;
    const planned = resolveUndeliveredTaskUpdate(task, outcome, owner.id);
    const result = await update(task.id, { ...planned, metadata: { ...planned.metadata, legacyDeliveryRecovery: owner.id } }, task.taskType || 'user', {
      expectedStatus: 'blocked', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: owner.id, startedAt: owner.startedAt }, preserveRetryBudget: true,
    });
    if (result?.error || result?.statusChanged || result?.status !== planned.status) continue;
    if (planned.metadata.retryPendingCleanup) {
      await release({ agentId: owner.id, task, success: false, agentMetadata: owner.metadata });
    }
    recovered++;
  }
  return { recovered };
}
