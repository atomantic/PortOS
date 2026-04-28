/**
 * Shared markers for "recovery" tasks — administrative agents auto-spawned
 * to retry a failed merge or PR creation. Centralized so detection and
 * creation stay in sync.
 */

export const RECOVERY_TASK_PREFIX = '[Recovery]';

export function isRecoveryTask(task) {
  if (!task) return false;
  if (task.metadata?.isRecovery === true) return true;
  return typeof task.description === 'string' && task.description.startsWith(RECOVERY_TASK_PREFIX);
}
