/**
 * Test for migration 337 — offer `claude-sonnet-5` on a Claude CLI/TUI record
 * that still lists only the retired `claude-sonnet-4-6` tier. Built on
 * `makeAdditiveProviderInsertMigration` (`_lib.js` family 7b); the shared
 * contract lives in `runAdditiveProviderInsertMigrationTests`
 * (`_testHelpers.js`) and is exercised here against 337's own `targets`.
 */
import { describe } from 'vitest';
import migration, { TARGETS } from './337-claude-sonnet-5-additive.js';
import { runAdditiveProviderInsertMigrationTests } from './_testHelpers.js';

describe('migration 337 — claude-sonnet-5 additive repair', () => {
  runAdditiveProviderInsertMigrationTests({ migration, targets: TARGETS, prefix: 'migration-337-' });
});
