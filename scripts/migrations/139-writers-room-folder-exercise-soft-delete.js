/**
 * Registration stub for Writers Room folder + exercise federation (#1645).
 *
 * Federating `writers_room_folders` and `writers_room_exercises` across peers
 * (follow-up to #1565, which federated works) requires a soft-delete tombstone on
 * each table — the LWW-per-id peer-sync model never propagates a HARD delete
 * (omitting a record lets a peer resurrect it), so a deletion has to ride as a
 * `deleted = TRUE` row the merge keeps and tombstone GC later hard-prunes.
 *
 * The two new columns on each table (`deleted BOOLEAN DEFAULT FALSE`,
 * `deleted_at TIMESTAMPTZ`) are ADDITIVE + idempotent, so they're applied at boot
 * by `ensureSchema()` in server/lib/db.js (ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS) and inline in server/scripts/init-db.sql for fresh installs. The
 * `scripts/migrations/` runner executes BEFORE the Postgres pool is initialized,
 * so the real DDL can't run here — same reason 048–054/138 are boot-time +
 * stub-registered.
 *
 * Existing rows default to `deleted = FALSE` (a live record, unchanged behavior).
 *
 * This stub exists so the change is *registered the standard way*: it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show when
 * folder/exercise soft-delete (and thus federation) was introduced.
 *
 * No-op + idempotent: nothing to do in the file runner.
 */

export default {
  async up() {
    console.log('🗂️  writers-room folder/exercise soft-delete: additive columns apply at boot via ensureSchema(); nothing to do in the file runner');
  },
};
