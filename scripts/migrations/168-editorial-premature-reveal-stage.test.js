import { describe } from 'vitest';

import migration from './168-editorial-premature-reveal-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 168 — seed premature-reveal editorial stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-premature-reveal'], prefix: 'migration-168-' });
});
