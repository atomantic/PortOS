import { describe } from 'vitest';
import { runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
} from './385-pipeline-scene-progression.js';

describe('migration 385 — Pipeline stalled-scene progression', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-385-',
  });
});
