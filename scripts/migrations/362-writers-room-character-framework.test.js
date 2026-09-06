import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './362-writers-room-character-framework.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 362 — writers-room character framework prompts', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-362-' });
});
