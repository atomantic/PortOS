/**
 * Registration stub for the `beeper_outbox` table (#36, decided on #8).
 *
 * The DDL — `CREATE TABLE IF NOT EXISTS beeper_outbox` plus
 * `idx_beeper_outbox_conversation_state` — is idempotent and lives in
 * `ensureSchema()` (`server/lib/db/schema/beeper.js`), which runs at server
 * boot AFTER the DB pool is up, and in the fresh-install seed
 * (`server/scripts/init-db.sql`). The `scripts/migrations/` runner executes
 * BEFORE the pool is initialized, so a DDL statement cannot live here — the
 * same reason migration 335 (`tribe_identities`) is boot-time + stub-registered.
 *
 * This stub exists so the new-table change is registered the standard way: it
 * lands in `data/migrations.applied.json`, so the ledger and `git log` show
 * when the outbox was introduced. The table is additive and machine-local, and
 * there is nothing to backfill — PortOS has never sent a Beeper message, so no
 * install has outbound history to migrate.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🫧 beeper_outbox: table + index created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
