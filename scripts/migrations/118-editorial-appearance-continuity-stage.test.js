import { describe } from 'vitest';

import migration from './118-editorial-appearance-continuity-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 118 — seed editorial-appearance-continuity stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-appearance-continuity'], prefix: 'migration-118-' });
});
