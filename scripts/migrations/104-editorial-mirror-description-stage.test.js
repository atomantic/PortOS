import { describe } from 'vitest';

import migration from './104-editorial-mirror-description-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 104 — seed editorial-mirror-description stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-mirror-description'], prefix: 'migration-104-' });
});
