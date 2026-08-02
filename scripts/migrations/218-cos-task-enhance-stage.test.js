import { describe } from 'vitest';

import migration from './218-cos-task-enhance-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The CoS task-enhancement stage (#3314). The drift catch is the point: this
// key was already named by the delete guard and the Prompt Manager's SYSTEM
// badge while shipping no template or config entry at all, which is exactly the
// state this suite now fails on.
describe('migration 218 — seed the cos-task-enhance stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['cos-task-enhance'],
    prefix: 'migration-218-',
  });
});
