import { describe } from 'vitest';

import migration from './106-editorial-kill-your-darlings-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 106 — seed editorial-kill-your-darlings stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-kill-your-darlings'], prefix: 'migration-106-' });
});
