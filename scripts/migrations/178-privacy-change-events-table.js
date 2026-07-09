/**
 * Registration stub for the Privacy Center change-of-address events table
 * (issue #2143, epic #2138).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS privacy_change_events` (+ its
 * index) — is idempotent and lives in `ensureSchema()` (`server/lib/db.js`) and
 * the fresh-install seed (`server/scripts/init-db.sql`), both of which run at
 * server boot AFTER the DB pool is up. The `scripts/migrations/` runner executes
 * BEFORE the pool is initialized, so a DB-table create cannot live here — the
 * same reason migrations 048–052, 108, 160/161/162, and 176 are boot-time +
 * stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when the change-events table was introduced. The table is additive
 * (brand-new, machine-local db-primary store) with no data backfill — the
 * privacyChanges service populates it lazily as the user declares changes.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('📮 privacy_change_events: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
