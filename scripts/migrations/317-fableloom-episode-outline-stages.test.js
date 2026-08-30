import { describe } from 'vitest';

import migration from './317-fableloom-episode-outline-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 317 — seed the FableLoom episode-outline stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-outline-episode', 'fableloom-review-episode-outline'],
    prefix: 'migration-317-',
  });
});
