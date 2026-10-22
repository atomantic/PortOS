import { describe } from 'vitest';

import migration from './174-series-voice-discover-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 174 — seed series voice-discovery stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-series-voice-discover'], prefix: 'migration-174-' });
});
