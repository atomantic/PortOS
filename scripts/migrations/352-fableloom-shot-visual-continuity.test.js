import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './352-fableloom-shot-visual-continuity.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 352 — shot visual continuity', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-352-' });
});
