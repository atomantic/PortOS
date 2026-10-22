import { describe } from 'vitest';

import migration from './101-editorial-dead-metaphor-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 101 — seed editorial-dead-metaphor stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-dead-metaphor'], prefix: 'migration-101-' });
});
