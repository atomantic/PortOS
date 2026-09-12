import { describe } from 'vitest';
import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './379-arc-episode-metadata-repair.js';
describe('migration 379 — episode planning metadata repairs', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-379-episode-metadata-' });
});
