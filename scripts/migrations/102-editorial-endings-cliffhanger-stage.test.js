import { describe } from 'vitest';

import migration from './102-editorial-endings-cliffhanger-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 102 — seed editorial-endings-cliffhanger stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-endings-cliffhanger'], prefix: 'migration-102-' });
});
