import { describe } from 'vitest';

import migration from './189-model-personality-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The two Digital Twin → Personality stages (#2610). The drift catch is the
// point: without it, renaming either reference template would surface only as
// POST /api/model-personality/run throwing "Stage not found" on a fresh install.
describe('migration 189 — seed model-personality stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['model-personality-profile', 'model-personality-alignment-scorer'],
    prefix: 'migration-189-',
  });
});
