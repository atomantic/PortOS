/**
 * Registration stub for FableLoom federation.
 *
 * Existing `fableloom_stories` rows need the additive `deleted` and
 * `deleted_at` columns so deletes can travel as LWW tombstones. The migration
 * runner starts before PostgreSQL is initialized, so the idempotent DDL lives
 * in `server/lib/db/schema/pipeline.js` and runs through ensureSchema at boot.
 * Fresh installs carry the same columns in `server/scripts/init-db.sql`.
 *
 * Existing records remain live through the `deleted = FALSE` default. This
 * stub records when the store became federated in the per-install migration
 * ledger; no file-backed record rewrite is required because sanitizeLoom
 * backfills the tombstone fields on read.
 */

export default {
  async up() {
    console.log('🧶 FableLoom federation: additive tombstone columns apply at boot via ensureSchema(); nothing to do in the file runner');
  },
};
