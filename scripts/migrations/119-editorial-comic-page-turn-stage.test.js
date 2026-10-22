import { describe } from 'vitest';

import migration from './119-editorial-comic-page-turn-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 119 — seed editorial-comic-page-turn stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-comic-page-turn'], prefix: 'migration-119-' });
});
