import { describe } from 'vitest';

import migration, {
  applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5,
} from './324-fableloom-playable-challenge-contract.js';
import { runPromptMigrationTests } from './_testHelpers.js';

describe('migration 324 — FableLoom playable challenge prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-324-',
  });
});
