/**
 * Registration stub for Creative Commission feedback split-record federation
 * (issue #2686, epic #2657 — Autonomous Creation Engine).
 *
 * Two things this change introduces, neither of which can run in the file-runner:
 *
 *   1. The `commission_feedback` table (+ its index). The DDL is idempotent and
 *      lives in `ensureSchema()` (`server/lib/db.js`), which runs at server boot
 *      AFTER the DB pool is up. The `scripts/migrations/` runner executes BEFORE
 *      the pool is initialized, so a table create cannot live here — the same
 *      reason migrations 048–052, 108, 160/161/162, 176, and 178 are boot-time +
 *      stub-registered.
 *
 *   2. The data backfill: splitting each commission's legacy INLINE `feedback[]`
 *      (Phase 2 storage) OUT into the new federated `commissionFeedback` record
 *      kind and clearing the inline array. That also needs the DB pool, so it
 *      runs at boot via `backfillAllCommissionFeedback()` (server/index.js, just
 *      before the commission scheduler arms) and is idempotent — after the first
 *      pass commissions carry `feedback: []`, so a re-run is a no-op, and the
 *      per-reaction upsert is never-clobber (a newer peer reaction always wins).
 *
 * This stub exists so the change is registered the standard way: it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show when
 * commission feedback began federating. No-op + idempotent: nothing to do here.
 *
 * The commission BRIEF also federates now (record kind `creativeCommission`,
 * category `creativeCommissions`) so a synced reaction attaches to the same
 * commission on every peer — the `schedule`/`runs`/`assignment` stay
 * machine-local (stripped from the wire). That needs soft-delete tombstone
 * columns (`deleted`/`deleted_at`) on the existing `creative_commissions` table;
 * the idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lives in ensureSchema
 * (server/lib/db.js) and runs at boot for installs predating the split.
 *
 * NOTE (schema-version bumps): this change adds `commissionFeedback: 1` AND
 * `creativeCommissions: 1` to `PORTOS_SCHEMA_VERSIONS` (server/lib/schemaVersions.js).
 * No storage-layout migration is needed for either (a brand-new record kind and an
 * additive tombstone-column upgrade, not a reshape of an existing on-disk store).
 */

export default {
  async up() {
    console.log('🎯 commission_feedback: table created idempotently by ensureSchema at boot; inline→federated split runs via backfillAllCommissionFeedback — nothing to do in the file runner (#2686)');
  },
};
