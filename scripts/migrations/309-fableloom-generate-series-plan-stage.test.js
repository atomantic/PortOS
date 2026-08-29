import { describe } from 'vitest';

import migration from './309-fableloom-generate-series-plan-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 309 — seed the FableLoom series-plan generation stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-generate-series-plan'],
    prefix: 'migration-309-',
  });
});
