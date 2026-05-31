/**
 * Registration stub for the canon↔catalog reconciliation data repair.
 *
 * The bidirectional projection (server/services/catalogCanonProjection.js)
 * keeps an embedded universe-canon entry and its `catalog_ingredients` row in
 * lockstep going forward. But on the FIRST boot after the upgrade, the two
 * stores can already disagree (they were copy-on-write mirrors before). The
 * repair walks every universe canon entry carrying an `ingredientId`,
 * LWW-merges embedded vs catalog payload on `updatedAt`, and writes the winner
 * to BOTH sides so they converge.
 *
 * The actual repair walks the catalog (Postgres) + universe records, so it
 * needs the pool — but the `scripts/migrations/` runner executes BEFORE the
 * pool is initialized (same reason migrations 048–053 are boot-time + stub-
 * registered). The reconcile therefore runs at boot from
 * `server/scripts/reconcileCanonCatalog.js` (after `ensureSchema()` + the
 * bible→catalog backfill + `migrateCatalogPayload`), marker-gated in
 * `data/catalog-canon-reconcile.applied.json`.
 *
 * This stub exists so the change is registered the standard way: it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show
 * when the canon↔catalog reconciliation was introduced.
 *
 * No-op + idempotent: nothing to do in the file runner.
 */

export default {
  async up() {
    console.log('🔁 canon↔catalog reconcile: repair runs at boot (reconcileCanonCatalog.js); nothing to do in the file runner');
  },
};
