import { describe } from 'vitest';

import migration from './099-editorial-interiority-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 099 — seed editorial-interiority stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-interiority'], prefix: 'migration-099-' });
});
