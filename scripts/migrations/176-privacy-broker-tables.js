/**
 * Registration stub for the Privacy Center data-broker database + case ledger
 * (issue #2144, epic #2138).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS privacy_brokers` and
 * `privacy_broker_cases` (+ their indexes) — is idempotent and lives in
 * `ensureSchema()` (`server/lib/db.js`) and the fresh-install seed
 * (`server/scripts/init-db.sql`), both of which run at server boot AFTER the DB
 * pool is up. The `scripts/migrations/` runner executes BEFORE the pool is
 * initialized, so a DB-table create cannot live here — the same reason
 * migrations 048–052, 108, and 160/161/162 are boot-time + stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when the broker tables were introduced. Both tables are additive (brand-
 * new, machine-local db-primary stores) with no data backfill — the
 * privacyBrokers service SEEDS `privacy_brokers` LAZILY from
 * data.reference/privacy/brokers.json on first read (never at boot, no network),
 * and the scan engine populates `privacy_broker_cases` on the first user-
 * triggered scan pass.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🗂️ privacy_brokers/privacy_broker_cases: tables created idempotently by ensureSchema at boot; curated seed loads lazily on first read — nothing to do in the file runner');
  },
};
