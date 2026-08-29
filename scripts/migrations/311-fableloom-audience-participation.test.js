import { describe } from 'vitest';

import migration, {
  applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5,
} from './311-fableloom-audience-participation.js';
import { runPromptMigrationTests } from './_testHelpers.js';

describe('migration 311 — FableLoom audience participation prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-311-',
  });
});
