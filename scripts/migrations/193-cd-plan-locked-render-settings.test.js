/**
 * Test for migration 193 — cd-plan gains the "## Locked render settings" note.
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
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './193-cd-plan-locked-render-settings.js';

describe('migration 193 — cd-plan locked render settings', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-193-',
  });
});
