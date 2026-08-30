import { describe } from 'vitest';

import migration, {
  applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5,
} from './319-fableloom-protagonist-continuity.js';
import { runPromptMigrationTests } from './_testHelpers.js';

describe('migration 319 — FableLoom protagonist continuity prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-319-',
  });
});
