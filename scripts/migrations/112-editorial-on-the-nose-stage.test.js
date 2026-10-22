import { describe } from 'vitest';

import migration from './112-editorial-on-the-nose-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 112 — seed editorial-on-the-nose stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-on-the-nose'], prefix: 'migration-112-' });
});
