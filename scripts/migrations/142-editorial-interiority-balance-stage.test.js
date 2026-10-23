import { describe } from 'vitest';

import migration from './142-editorial-interiority-balance-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 142 — seed interiority-balance editorial stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-interiority-balance'], prefix: 'migration-142-' });
});
