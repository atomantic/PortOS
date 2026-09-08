import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './369-writers-room-evaluate-character-evolution.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 369 — writers-room evaluate character-evolution lens', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-369-' });
});
