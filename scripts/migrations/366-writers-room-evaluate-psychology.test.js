import { describe } from 'vitest';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './366-writers-room-evaluate-psychology.js';
import { runPromptMigrationTests } from './_testHelpers.js';
describe('migration 366 — writers-room evaluate psychology/sliders prose', () => {
  runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5, prefix: 'migration-366-' });
});
