import { describe } from 'vitest';

import migration from './110-editorial-telling-emotion-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 110 — seed editorial-telling-emotion stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-telling-emotion'], prefix: 'migration-110-' });
});
