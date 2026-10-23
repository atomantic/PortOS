import { describe } from 'vitest';

import migration from './134-editorial-voice-consistency-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 134 — seed editorial-voice-consistency stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-voice-consistency'], prefix: 'migration-134-' });
});
