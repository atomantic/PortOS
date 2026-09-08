import { describe } from 'vitest';
import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './371-video-treatment-contract.js';

describe('migration 371 — standalone Video treatment contract', () => {
  runPromptMigrationTests({
    migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5,
    prefix: 'migration-371-',
  });
});
