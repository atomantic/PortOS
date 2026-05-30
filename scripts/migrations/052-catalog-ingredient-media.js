/**
 * Registration stub for the catalog_ingredient_media table (typed media
 * attachments — portrait / reference / audio / video / document).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS catalog_ingredient_media` plus
 * its indexes and the `trg_catalog_media_sync_seq` trigger — is idempotent and
 * lives in `ensureSchema()` (`server/lib/db.js`) and the fresh-install seed
 * (`server/scripts/init-db.sql`), both of which run at server boot AFTER the DB
 * pool is up. The `scripts/migrations/` runner executes BEFORE the pool is
 * initialized, so a DB-table create cannot live here — the same reason
 * migrations 048/049/050/051 are boot-time + stub-registered.
 *
 * This stub exists so the media-attachment change is *registered the standard
 * way*: it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when ingredient media attachments were introduced. The table
 * is additive (a brand-new table) and stores only `media_key` REFERENCES into
 * the existing media library — no bytes are duplicated and there is no existing
 * data to backfill.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🖼️  catalog_ingredient_media: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
