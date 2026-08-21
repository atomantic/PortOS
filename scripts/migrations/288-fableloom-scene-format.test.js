/**
 * Test for migration 288 — the FableLoom stages take the scene-format
 * variable ({{sceneFormatContract}} / {{narrationFormatContract}}).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './288-fableloom-scene-format.js';

describe('migration 288 — FableLoom scene format', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-288-',
  });
});
