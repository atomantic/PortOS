/**
 * CoS task-learning bucket resolver for client-side duration displays.
 *
 * Re-export of `server/lib/taskTypeBucket.js` — the one definition of the
 * bucket rules, imported rather than copied so an ETA key cannot drift from
 * the history the server records (e.g. after a scheduled-task rename).
 */
export {
  EXTERNAL_UNTYPED_TASK_TYPE,
  extractTaskType as extractCosTaskType,
} from '../../../server/lib/taskTypeBucket.js';
