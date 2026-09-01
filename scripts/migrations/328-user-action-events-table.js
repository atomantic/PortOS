/**
 * Registration stub for the user_action_events table (issue #5594, epic #5593).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS user_action_events` plus its
 * `idx_user_action_dedupe` unique index and the `idx_user_action_happened` /
 * `idx_user_action_type_time` / `idx_user_action_actor_time` indexes — is
 * idempotent and lives in `ensureSchema()` (`server/lib/db/schema/userActions.js`,
 * composed by `server/lib/db.js`) and the fresh-install seed
 * (`server/scripts/init-db.sql`), both of which run at server boot AFTER the DB
 * pool is up. The `scripts/migrations/` runner executes BEFORE the pool is
 * initialized, so a DB-table create cannot live here — the same reason
 * migrations 048–052, 108, and 161 are boot-time + stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when the operator-action ledger was introduced. The table is additive (a
 * brand-new, machine-local db-primary store), so there is no data backfill —
 * `server/services/userActions.js` populates it as the user acts.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🧾 user_action_events: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
