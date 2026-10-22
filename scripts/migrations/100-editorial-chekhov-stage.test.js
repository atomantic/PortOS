import { describe } from 'vitest';

import migration from './100-editorial-chekhov-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 100 — seed editorial-chekhov stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-chekhov'], prefix: 'migration-100-' });
});
