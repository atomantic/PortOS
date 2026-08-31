import { describe } from 'vitest';

import migration from './320-fableloom-editorial-automation-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 320 — seed the FableLoom editorial automation stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-editorial-remediate', 'fableloom-review-playthroughs'],
    prefix: 'migration-320-',
  });
});
