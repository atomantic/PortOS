/**
 * Registration stub for the catalog scrap-chunking schema change.
 *
 * Long scrap pastes now split into a parent row (chunk_index 0, parent_scrap_id
 * NULL, raw_text = the FULL original text) plus N child rows (parent_scrap_id →
 * parent, chunk_index 1..N, raw_text = the chunk slice). The catalog extractor
 * runs per-child and unions the drafts (dedup by name+type, keep first).
 *
 * The two new columns (`chunk_index INT NOT NULL DEFAULT 0`,
 * `parent_scrap_id TEXT REFERENCES catalog_scraps(id) ON DELETE CASCADE`) and
 * the `idx_catalog_scraps_parent` index are ADDITIVE + idempotent, so they're
 * applied at boot by `ensureSchema()` in server/lib/db.js (ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS) and inline in server/scripts/init-db.sql for fresh
 * installs. The `scripts/migrations/` runner executes BEFORE the Postgres pool
 * is initialized, so the real DDL can't run here — same reason migrations
 * 048–053 are boot-time + stub-registered.
 *
 * Existing rows default to chunk_index 0 / parent_scrap_id NULL — a plain
 * non-chunked scrap, unchanged behavior. We do NOT retro-chunk existing scraps.
 *
 * This stub exists so the change is *registered the standard way*: it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show when
 * scrap chunking was introduced.
 *
 * No-op + idempotent: nothing to do in the file runner.
 */

export default {
  async up() {
    console.log('🧩 catalog scrap chunking: additive columns apply at boot via ensureSchema(); nothing to do in the file runner');
  },
};
