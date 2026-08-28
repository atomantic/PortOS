import { describe } from 'vitest';

import migration from './306-fableloom-episode-feedback-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 306 — seed the FableLoom episode feedback stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-feedback-episode'],
    prefix: 'migration-306-',
  });
});
