import { describe } from 'vitest';
import migration, { TARGETS } from './404-grok-47-additive.js';
import { runAdditiveProviderInsertMigrationTests } from './_testHelpers.js';

describe('migration 404 — offer Grok 4.7 while preserving configured selections', () => {
  runAdditiveProviderInsertMigrationTests({ migration, targets: TARGETS, prefix: 'migration-404-' });
});
