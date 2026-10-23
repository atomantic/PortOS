import { describe } from 'vitest';

import migration from './116-editorial-unmodeled-names-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 116 — seed editorial-unmodeled-names stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-unmodeled-names'], prefix: 'migration-116-' });
});
