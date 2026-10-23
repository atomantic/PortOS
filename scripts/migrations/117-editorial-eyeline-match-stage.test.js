import { describe } from 'vitest';

import migration from './117-editorial-eyeline-match-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 117 — seed editorial-eyeline-match stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-eyeline-match'], prefix: 'migration-117-' });
});
