/**
 * Registration stub for the Privacy Center Trusted Organizations registry
 * (issue #2141, epic #2138).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS privacy_orgs` and
 * `privacy_org_holdings` (+ their indexes) — is idempotent and lives in
 * `ensureSchema()` (`server/lib/db.js`) and the fresh-install seed
 * (`server/scripts/init-db.sql`), both of which run at server boot AFTER the
 * DB pool is up. The `scripts/migrations/` runner executes BEFORE the pool is
 * initialized, so a DB-table create cannot live here — the same reason
 * migrations 048–052, 108, and 160/161 are boot-time + stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*:
 * it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when the trusted-organizations tables were introduced. Both
 * tables are additive (brand-new, machine-local db-primary stores) with no
 * data backfill — the privacyOrgs service populates them lazily as the user
 * adds organizations and holdings.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🏢 privacy_orgs/privacy_org_holdings: tables created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
