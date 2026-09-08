import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './361-series-concept-character-engines.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 361 — series concept character engines', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-361-' });
});
