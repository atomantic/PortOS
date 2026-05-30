/**
 * Registration stub for the per-record catalog payload-schemaVersion
 * migration.
 *
 * The actual work — walking `catalog_ingredients` rows whose stored
 * `payload.schemaVersion` lags the registry-current and applying the per-type
 * upgrader chain — lives in `server/scripts/migrateCatalogPayload.js` and runs
 * at server boot, AFTER `ensureSchema()` (it needs Postgres tables). The
 * `scripts/migrations/` runner (`scripts/run-migrations.js`) executes BEFORE
 * the DB pool is initialized, so a DB walk cannot live here — the same reason
 * `migrateBibleToCatalog` runs at boot rather than as a file-runner migration.
 *
 * This stub exists so the migration is *registered the standard way*: it lands
 * in `data/migrations.applied.json`, so `git log` / the migration ledger show
 * the payload-versioning migration was introduced in this release, and so a
 * future audit of "which migrations has this install seen" is complete. The
 * boot-time `migrateCatalogPayload` keeps its own `data/catalog-payload.applied.json`
 * high-water marker (mirroring `migrateBibleToCatalog`'s
 * `catalog-backfill.applied.json`) for the idempotent DB walk.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🧬 catalog payload schemaVersion: per-record migration runs at boot (server/scripts/migrateCatalogPayload.js); nothing to do in the file runner');
  },
};
