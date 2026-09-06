import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './350-fableloom-opening-comprehension.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 350 — opening comprehension', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-350-' });
});
