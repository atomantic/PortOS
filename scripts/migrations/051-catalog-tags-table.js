/**
 * Registration stub for the catalog_tags table (tag taxonomy).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS catalog_tags` plus its indexes
 * and the `trg_catalog_tag_updated_at` trigger — is idempotent and lives in
 * `ensureSchema()` (`server/lib/db.js`) and the fresh-install seed
 * (`server/scripts/init-db.sql`), both of which run at server boot AFTER the DB
 * pool is up. The `scripts/migrations/` runner executes BEFORE the pool is
 * initialized, so a DB-table create cannot live here — the same reason
 * migrations 048/049/050 are boot-time + stub-registered.
 *
 * This stub exists so the tag-taxonomy change is *registered the standard way*:
 * it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when the canonical tag table was introduced. The table is
 * additive (a brand-new table; the freeform `catalog_ingredients.tags TEXT[]`
 * column is unchanged), so there is no data backfill to perform here —
 * `catalogDB.normalizeTags` populates `catalog_tags` lazily on the next
 * ingredient create/update.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🏷️  catalog_tags: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
