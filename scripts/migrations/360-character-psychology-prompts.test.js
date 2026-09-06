import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './360-character-psychology-prompts.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 360 — character psychology prompts', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-360-' });
});
