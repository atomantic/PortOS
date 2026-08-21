/**
 * Test for migration 289 — seeding the FableLoom reformat stage.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';
import migration from './289-fableloom-reformat-stage.js';

describe('migration 289 — FableLoom reformat stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['fableloom-reformat-scenes'],
    prefix: 'migration-289-',
  });
});
