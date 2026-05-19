/**
 * Test for migration 023 — resolve prompt gains a per-episode-synopsis
 * anchor bullet at the top of "How to resolve."
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`). The 6 standard prompt-migration
 * test bodies live in `./_testHelpers.js`.
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './023-resolve-prompt-episode-anchor.js';

describe('migration 023 — resolve prompt episode-synopsis anchor', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-023-',
  });
});
