import { describe } from 'vitest';

import migration from './109-editorial-arc-transitions-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 109 — seed editorial-arc-transitions stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-arc-transitions'], prefix: 'migration-109-' });
});
