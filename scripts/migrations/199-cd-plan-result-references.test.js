/**
 * Test for migration 199 — cd-plan gains the "## Referencing a prior step's
 * result" note documenting `{{steps.<stepId>.result.<key>}}` (#2773).
 *
 * Uses the shared prompt-migration harness (seeds a fixture from the live
 * data.reference/ template, asserts an install on the accepted-old hash is
 * auto-updated to the new shipped hash and a customized copy is left alone).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './199-cd-plan-result-references.js';

describe('migration 199 — cd-plan cross-step result references', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-199-',
  });
});
