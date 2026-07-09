/**
 * Registration stub for the Privacy Center PII Vault tables (issue #2140,
 * epic #2138).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS privacy_vault_records` (+ its
 * `idx_privacy_vault_records_type` index) and `privacy_consents` — is
 * idempotent and lives in `ensureSchema()` (`server/lib/db.js`) and the
 * fresh-install seed (`server/scripts/init-db.sql`), both of which run at
 * server boot AFTER the DB pool is up. The `scripts/migrations/` runner
 * executes BEFORE the pool is initialized, so a DB-table create cannot live
 * here — the same reason migrations 048–052 and 108 are boot-time +
 * stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*:
 * it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when the privacy tables were introduced. Both tables are
 * additive (brand-new, machine-local db-primary stores) with no data
 * backfill — the privacyVault service populates them lazily on the first
 * vault record create (which also self-heals PRIVACY_VAULT_KEY into `.env`).
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🔐 privacy_vault_records/privacy_consents: tables created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
