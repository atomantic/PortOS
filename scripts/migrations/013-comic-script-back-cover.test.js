/**
 * Test for migration 013 — pipeline-comic-script.md gains a `## Back cover
 * concept` section.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './013-comic-script-back-cover.js';

describe('migration 013 — comic-script back-cover', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-013-',
  });
});
