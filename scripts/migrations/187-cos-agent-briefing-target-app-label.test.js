/**
 * Test for migration 187 — cos-agent-briefing.md gates the stock "Target
 * Application" heading on {{targetAppLabel}} instead of {{task.metadata.app}}.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './187-cos-agent-briefing-target-app-label.js';

describe('migration 187 — cos-agent-briefing target-app label gating', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-187-',
  });
});
