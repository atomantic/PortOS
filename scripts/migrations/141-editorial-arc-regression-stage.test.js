import { describe } from 'vitest';

import migration from './141-editorial-arc-regression-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 141 — seed editorial-arc-regression stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-arc-regression'], prefix: 'migration-141-' });
});
