/**
 * Test for migration 172 — pipeline-season-episodes.md gains the structure-rules
 * block (try-fail mandate, beat rules, active climax).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './172-structure-rules-season-episodes.js';

describe('migration 172 — season-episode structure rules', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-172-',
  });
});
