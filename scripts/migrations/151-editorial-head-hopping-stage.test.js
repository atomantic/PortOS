import { describe } from 'vitest';

import migration from './151-editorial-head-hopping-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 151 — seed editorial-head-hopping stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-head-hopping'], prefix: 'migration-151-' });
});
