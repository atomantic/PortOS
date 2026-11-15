import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
} from './461-simplify-skill-module-catalog.js';

describe('migration 461 — simplify skill module catalog', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-461-',
    subdir: 'skills',
  });
});
