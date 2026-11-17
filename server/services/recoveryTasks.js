/**
 * Shared markers for "recovery" tasks — administrative agents auto-spawned
 * to retry a failed merge or PR creation. Centralized so detection and
 * creation stay in sync.
 */

import { isTruthyMeta } from '../lib/metadataFlags.js';

export const RECOVERY_TASK_PREFIX = '[Recovery]';

export function isRecoveryTask(task) {
  if (!task) return false;
  if (isTruthyMeta(task.metadata?.isRecovery)) return true;
  return typeof task.description === 'string' && task.description.startsWith(RECOVERY_TASK_PREFIX);
}
