/**
 * Registration stub for the catalog_ingredient_relations table.
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS catalog_ingredient_relations`
 * plus its indexes and the `trg_catalog_relation_sync_seq` trigger — is
 * idempotent and lives in `ensureSchema()` (`server/lib/db.js`) and the
 * fresh-install seed (`server/scripts/init-db.sql`), both of which run at
 * server boot AFTER the DB pool is up. The `scripts/migrations/` runner
 * executes BEFORE the pool is initialized, so a DB-table create cannot live
 * here — the same reason migrations 048/049 are boot-time + stub-registered.
 *
 * This stub exists so the relations table change is *registered the standard
 * way*: it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when the catalog graph seam was introduced. The table itself
 * is additive (a brand-new table — no existing rows to walk), so there is no
 * data backfill to perform.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🔗 catalog_ingredient_relations: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
