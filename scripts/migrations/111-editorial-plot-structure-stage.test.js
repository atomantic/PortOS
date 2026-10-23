import { describe } from 'vitest';

import migration from './111-editorial-plot-structure-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 111 — seed editorial-plot-structure stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-plot-structure'], prefix: 'migration-111-' });
});
