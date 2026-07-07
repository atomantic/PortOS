/**
 * Test for migration 171 — universe-character-expand.md gains the character
 * framework doctrine (Ghost→Wound→Lie→Want→Need, arc type, Three Sliders,
 * secrets).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './171-character-framework-prompt.js';

describe('migration 171 — character framework generation doctrine', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-171-',
  });
});
