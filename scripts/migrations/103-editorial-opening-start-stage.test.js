import { describe } from 'vitest';

import migration from './103-editorial-opening-start-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 103 — seed editorial-opening-start stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-opening-start'], prefix: 'migration-103-' });
});
