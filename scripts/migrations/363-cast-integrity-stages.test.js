import { describe } from 'vitest';

import migration from './363-cast-integrity-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 363 — seed the cast integrity stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['universe-cast-integrity-review', 'universe-character-augment'],
    prefix: 'migration-363-',
  });
});
