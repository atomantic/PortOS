import { describe } from 'vitest';

import migration from './105-editorial-dialogue-pleasantries-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 105 — seed editorial-dialogue-pleasantries stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-dialogue-pleasantries'], prefix: 'migration-105-' });
});
