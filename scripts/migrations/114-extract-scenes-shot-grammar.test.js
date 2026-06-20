/**
 * Test for migration 114 — pipeline-extract-scenes.md gains per-shot
 * shotType + screenDirection (#1315).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './114-extract-scenes-shot-grammar.js';

describe('migration 114 — extract-scenes shot grammar (shotType + screenDirection)', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-114-',
  });
});
