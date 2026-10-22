import { describe } from 'vitest';

import migration from './113-editorial-voice-distinctiveness-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 113 — seed editorial-voice-distinctiveness stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-voice-distinctiveness'], prefix: 'migration-113-' });
});
