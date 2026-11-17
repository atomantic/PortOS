/**
 * Registration stub for Creative Commission feedback split-record federation (issue #2686, epic #2657).
 *
 * Neither part can run in the file-runner, which executes BEFORE the DB pool is initialized (as for migrations 048–052, 108, 160–162, 176, 178): (1) the `commission_feedback` table + index, whose idempotent DDL lives in `ensureSchema()` (`server/lib/db.js`);
 * (2) the backfill splitting each commission's legacy INLINE `feedback[]` into the federated `commissionFeedback` record kind, run at boot via `backfillAllCommissionFeedback()` (server/index.js, before the commission scheduler arms), idempotent and never-clobber (a newer peer reaction wins).
 * The commission BRIEF also federates (record kind `creativeCommission`, category `creativeCommissions`) so a synced reaction attaches to the same commission on every peer; `schedule`/`runs`/`assignment` stay machine-local. That needs soft-delete
 * tombstone columns on `creative_commissions`, added by an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in ensureSchema. This change adds `commissionFeedback: 1` AND `creativeCommissions: 1` to `PORTOS_SCHEMA_VERSIONS`; no storage-layout migration is needed. This stub lands the change in `data/migrations.applied.json`.
 */

export default {
  async up() {
    console.log('🎯 commission_feedback: table created idempotently by ensureSchema at boot; inline→federated split runs via backfillAllCommissionFeedback — nothing to do in the file runner (#2686)');
  },
};
