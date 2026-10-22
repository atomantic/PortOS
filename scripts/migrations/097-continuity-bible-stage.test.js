import { describe } from 'vitest';

import migration from './097-continuity-bible-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 097 — seed continuity-bible stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-continuity-bible'], prefix: 'migration-097-' });
});
