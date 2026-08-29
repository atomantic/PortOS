import { describe } from 'vitest';

import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './310-fableloom-camera-cuts.js';
import { runPromptMigrationTests } from './_testHelpers.js';

describe('migration 310 — FableLoom camera-cut prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-310-',
  });
});
