import { describe } from 'vitest';

import migration from './131-editorial-climax-agency-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 131 — seed editorial-climax-agency stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-climax-agency'], prefix: 'migration-131-' });
});
