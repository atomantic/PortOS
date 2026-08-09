import { describe } from 'vitest';

import migration from './235-pipeline-self-improve-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The autopilot self-improvement post-mortem stage. The drift catch is the
// point: if the reference template or its stage-config entry ever stops
// shipping, a self-improvement-enabled run would throw "Stage not found" at its
// terminal — turning a merely-paused run into an errored one — with nothing
// failing here first.
describe('migration 235 — seed the pipeline self-improvement stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-self-improve'],
    prefix: 'migration-235-',
  });
});
