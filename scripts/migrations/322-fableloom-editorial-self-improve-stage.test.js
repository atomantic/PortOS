import { describe } from 'vitest';

import migration from './322-fableloom-editorial-self-improve-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 322 — seed the FableLoom editorial self-improvement stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-editorial-self-improve'],
    prefix: 'migration-322-',
  });
});
