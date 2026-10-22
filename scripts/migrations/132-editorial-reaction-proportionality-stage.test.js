import { describe } from 'vitest';

import migration from './132-editorial-reaction-proportionality-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 132 — seed editorial-reaction-proportionality stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-reaction-proportionality'], prefix: 'migration-132-' });
});
