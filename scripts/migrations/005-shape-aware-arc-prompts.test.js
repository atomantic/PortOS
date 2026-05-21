/**
 * Test for migration 005 — pipeline arc / season / verify / resolve prompts
 * gain Vonnegut-shape variables.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './005-shape-aware-arc-prompts.js';

describe('migration 005 — shape-aware arc/volume prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-005-',
    createIfMissing: true,
  });
});
