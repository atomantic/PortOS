import { isDeliveryCleanupHeld, isRetryHeld } from '../lib/taskRetryHold.js';
import { hasSpawnBudgetResetPrerequisite } from '../lib/taskBlockCategories.js';
import { matchesLatestTaskDispatch } from './agent/agentCompletionTaskHandoff.js';

/** Resolve the stopped run whose retained checkout an explicit reset resumes: the only one, or among several the task's latest dispatch. */
export async function prepareExplicitOrphanBudgetReset(task) {
  if (!['in_progress', 'blocked'].includes(task?.status) || isDeliveryCleanupHeld(task.metadata) || isRetryHeld(task.metadata)
    || hasSpawnBudgetResetPrerequisite(task.metadata)) {
    return { error: 'Task cleanup owns this checkout; inspect its recovery before resetting the budget' };
  }
  const { readAgentsStateForSafetyCheck } = await import('./cos/cosState.js');
  const state = await readAgentsStateForSafetyCheck().catch(() => null);
  if (!state?.trusted) return { error: 'Agent history is unreadable; inspect the retained checkout before retrying' };
  const owners = Object.values(state.agents || {}).filter(agent => agent.taskId === task.id);
  if (owners.some(agent => ['running', 'paused'].includes(agent.status))) return { error: 'An agent still owns this task' };
  const completed = owners.filter(agent => agent.status === 'completed');
  if (!completed.length) {
    // Completed runs leave live state after completedAgentRetentionMs, so none left is not ambiguity.
    // A blocked task already dropped its resume pointer and restarts clean exactly as Unblock does;
    // forceSpawnTask's inactive-owner fence still refuses the write if an agent appears. An
    // in_progress task may hold uncommitted work only the archived run could identify, so it stays held.
    if (task.status === 'blocked') return { owner: null, pointer: null };
    return { error: 'No stopped run of this task is left in agent history; inspect its checkout before retrying' };
  }
  // A task at its spawn cap has several stopped runs. The one whose dispatch
  // receipt still matches the task ran last, and its checkout is the one to resume.
  const latest = completed.length > 1 ? completed.filter(agent => matchesLatestTaskDispatch(agent, task)) : completed;
  if (latest.length !== 1 || !latest[0].id || !latest[0].startedAt) {
    return { error: 'The stopped run is ambiguous; inspect its retained checkout before retrying' };
  }
  const owner = latest[0];
  if (typeof owner.metadata?.isWorktree !== 'boolean') return { error: 'The stopped run has no verified checkout identity' };
  const { resolveTaskResumePatch } = await import('./agent/agentWorktreeCleanup.js');
  const pointer = await resolveTaskResumePatch({ task, agentId: owner.id, agentMetadata: owner.metadata }).catch(() => null);
  if (!pointer || (owner.metadata.isWorktree && !pointer.existingBranch && !pointer.resumeWorktreePath && !pointer.claimResumeInPlace)) {
    return { error: 'The retained checkout could not be safely identified' };
  }
  return { owner, pointer };
}
