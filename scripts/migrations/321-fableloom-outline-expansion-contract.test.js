import { describe } from 'vitest';

import migration, {
  applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5,
} from './321-fableloom-outline-expansion-contract.js';
import { runPromptMigrationTests } from './_testHelpers.js';

describe('migration 321 — FableLoom validated outline expansion contract', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-321-',
  });
});
