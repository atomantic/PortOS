import { describe } from 'vitest';
import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './372-video-source-context.js';
describe('migration 372 — resolved Video source context', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-372-' });
});
