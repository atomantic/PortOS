import { describe } from 'vitest';

import migration from './115-editorial-theme-coherence-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 115 — seed editorial-theme-coherence stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-theme-coherence'], prefix: 'migration-115-' });
});
