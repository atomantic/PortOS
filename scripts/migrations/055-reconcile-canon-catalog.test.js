/**
 * Migration 055 is a REGISTRATION STUB — the actual canon↔catalog reconcile
 * runs at boot from server/scripts/reconcileCanonCatalog.js (which needs the
 * Postgres pool, unavailable to the file runner). This stub exists only so the
 * change lands in the migration ledger; its `up()` is a logging no-op. The test
 * just asserts it runs without throwing so the boot runner never crashes on it.
 */

import { describe, it, expect } from 'vitest';
import migration from './055-reconcile-canon-catalog.js';

describe('migration 055 — reconcile-canon-catalog (registration stub)', () => {
  it('is a no-op that resolves without throwing', async () => {
    await expect(migration.up()).resolves.toBeUndefined();
  });
});
