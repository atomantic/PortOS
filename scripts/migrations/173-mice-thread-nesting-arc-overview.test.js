/**
 * Test for migration 173 — pipeline-arc-overview.md gains the MICE thread-nesting
 * instruction.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './173-mice-thread-nesting-arc-overview.js';

describe('migration 173 — MICE thread nesting (arc overview)', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-173-',
  });
});
