/**
 * Rename the framework-neutral UI lifecycle audit while preserving schedules,
 * app overrides, pending runs, execution history, and run-order dependencies.
 *
 * The task used to be stored as `react-lifecycle`; all newly written task IDs
 * use `ui-lifecycle`. See scripts/lib/renameScheduledTaskType.js for the merge
 * rules. The migration is idempotent and does not dispatch work.
 */

import { renameScheduledTaskType } from '../lib/renameScheduledTaskType.js';

export default {
  up: ({ rootDir }) => renameScheduledTaskType({ rootDir, from: 'react-lifecycle', to: 'ui-lifecycle' }),
};
