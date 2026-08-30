import { describe } from 'vitest';

import migration from './318-fableloom-series-teleplay-review-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 318 — seed the FableLoom full-teleplay review stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-review-series-teleplay'],
    prefix: 'migration-318-',
  });
});
