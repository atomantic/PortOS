import { describe } from 'vitest';

import migration from './135-editorial-fact-accuracy-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 135 — seed editorial-fact-accuracy stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-fact-accuracy'], prefix: 'migration-135-' });
});
