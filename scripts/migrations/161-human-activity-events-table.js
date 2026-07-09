/**
 * Registration stub for the human_activity_events table (issue #2150).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS human_activity_events` plus its
 * `idx_human_activity_dedupe` unique index and `idx_human_activity_happened`
 * index — is idempotent and lives in `ensureSchema()` (`server/lib/db.js`) and
 * the fresh-install seed (`server/scripts/init-db.sql`), both of which run at
 * server boot AFTER the DB pool is up. The `scripts/migrations/` runner executes
 * BEFORE the pool is initialized, so a DB-table create cannot live here — the
 * same reason migrations 048–052 and 108 are boot-time + stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when the human_activity_events table was introduced. The table is
 * additive (a brand-new, machine-local db-primary store), so there is no data
 * backfill — the humanActivity service and the message/calendar sync hooks
 * populate it lazily on the next sync.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🗓️  human_activity_events: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
