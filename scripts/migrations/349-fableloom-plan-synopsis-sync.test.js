import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './349-fableloom-plan-synopsis-sync.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 349 — FableLoom synopsis synchronization', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-349-' });
});
