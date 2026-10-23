import { describe } from 'vitest';

import migration from './143-editorial-object-weight-proportionality-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 143 — seed object weight-proportionality editorial stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-object-weight-proportionality'], prefix: 'migration-143-' });
});
