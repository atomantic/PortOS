/**
 * Test for migration 025 — idea / beat-sheet expansion stage prompt gains the
 * richer `{{#series.characters}}` iteration (role + physicalDescription /
 * description fallback + personality + background) that the prose,
 * comic-script, and teleplay templates already use.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`). The 6 standard prompt-migration
 * test bodies live in `./_testHelpers.js`.
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './025-idea-stage-character-detail.js';

describe('migration 025 — idea-stage character detail plumbing', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-025-',
  });
});
