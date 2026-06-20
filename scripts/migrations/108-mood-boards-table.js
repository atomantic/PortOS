/**
 * Registration stub for the mood_boards table (issue #911).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS mood_boards` plus its
 * `idx_mood_boards_updated` index and the `trg_mood_boards_audit` trigger — is
 * idempotent and lives in `ensureSchema()` (`server/lib/db.js`) and the
 * fresh-install seed (`server/scripts/init-db.sql`), both of which run at server
 * boot AFTER the DB pool is up. The `scripts/migrations/` runner executes BEFORE
 * the pool is initialized, so a DB-table create cannot live here — the same
 * reason migrations 048–052 are boot-time + stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when the mood_boards table was introduced. The table is additive (a
 * brand-new, local-only db-primary store), so there is no data backfill —
 * the moodBoard service populates it lazily on the first board create.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🎨 mood_boards: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
