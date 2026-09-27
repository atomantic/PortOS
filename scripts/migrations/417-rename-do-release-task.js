/**
 * Rename the scheduled `release-check` task to `do-release` while preserving
 * schedules, app overrides (including the operator's release options), pending
 * runs, execution history, and run-order dependencies.
 *
 * The old name described a readiness check; the task's job is to ship the
 * release. An uncustomized stored prompt keeps auto-upgrading after the move
 * because the integrity snapshot carries release-check's retired hashes under
 * `do-release` (TASK_TYPE_RENAMES in server/lib/scheduledTaskTypes.js).
 * See scripts/lib/renameScheduledTaskType.js for the merge rules. Idempotent;
 * it never dispatches work.
 */

import { renameScheduledTaskType } from '../lib/renameScheduledTaskType.js';

export default {
  up: ({ rootDir }) => renameScheduledTaskType({ rootDir, from: 'release-check', to: 'do-release' }),
};
