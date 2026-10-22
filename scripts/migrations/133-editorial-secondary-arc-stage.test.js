import { describe } from 'vitest';

import migration from './133-editorial-secondary-arc-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 133 — seed editorial-secondary-arc stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-secondary-arc'], prefix: 'migration-133-' });
});
