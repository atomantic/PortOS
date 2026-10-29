import { isDeliveryCleanupHeld, isRetryHeld } from '../lib/taskRetryHold.js';
import { hasSpawnBudgetResetPrerequisite } from '../lib/taskBlockCategories.js';

/** Resolve a unique stopped orphan's retained checkout before an explicit reset. */
export async function prepareExplicitOrphanBudgetReset(task) {
  if (!['in_progress', 'blocked'].includes(task?.status) || isDeliveryCleanupHeld(task.metadata) || isRetryHeld(task.metadata)
    || hasSpawnBudgetResetPrerequisite(task.metadata)) {
    return { error: 'Task cleanup owns this checkout; inspect its recovery before resetting the budget' };
  }
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  const state = await readAgentsStateForSafetyCheck().catch(() => null);
  if (!state?.trusted) return { error: 'Agent history is unreadable; inspect the retained checkout before retrying' };
  const owners = Object.values(state.agents || {}).filter(agent => agent.taskId === task.id);
  if (owners.some(agent => ['running', 'paused'].includes(agent.status))) return { error: 'An agent still owns this task' };
  const completed = owners.filter(agent => agent.status === 'completed');
  if (completed.length !== 1 || !completed[0].id || !completed[0].startedAt) {
    return { error: 'The stopped run is ambiguous; inspect its retained checkout before retrying' };
  }
  const owner = completed[0];
  if (typeof owner.metadata?.isWorktree !== 'boolean') return { error: 'The stopped run has no verified checkout identity' };
  const { resolveTaskResumePatch } = await import('./agentWorktreeCleanup.js');
  const pointer = await resolveTaskResumePatch({ task, agentId: owner.id, agentMetadata: owner.metadata }).catch(() => null);
  if (!pointer || (owner.metadata.isWorktree && !pointer.existingBranch && !pointer.resumeWorktreePath && !pointer.claimResumeInPlace)) {
    return { error: 'The retained checkout could not be safely identified' };
  }
  return { owner, pointer };
}
