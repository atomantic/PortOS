import { describe } from 'vitest';

import migration from './130-editorial-character-consistency-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 130 — seed editorial-character-consistency stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-character-consistency'], prefix: 'migration-130-' });
});
