import { describe } from 'vitest';
import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './383-pipeline-series-design.js';
describe('migration 383 — pipeline series design', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-383-' });
});
