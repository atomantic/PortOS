// Universe DDL — universes + universe run history. Extracted verbatim from
// ensureSchemaImpl() in server/lib/db.js (#2832); idempotent, runs on every boot.
export const universesDdl = [
    // Universe Builder records (Phase 3 Create migration, issue #1014). One row
    // per universe, the full sanitized record (canon bibles, categories,
    // compositeSheets, locks, influences) in `data` JSONB, moved out of
    // data/universes/{id}/index.json (collectionStore). Only the fields the
    // service/federation query, join, or sort on are mirrored into columns:
    // `name` (rename-cascade + delete-guard + list sort), `schema_version` (the
    // RECORD-shape version sanitizeTemplate stamps — a column so a future
    // migration can find unmigrated rows without parsing JSONB), `ephemeral`
    // (the snapshot loop filters local-only records), and the LWW/tombstone
    // trio (updated_at/deleted/deleted_at). NO sync_sequence: universes
    // federate via the EXISTING dataSync snapshot/push model (LWW on the body's
    // updatedAt), NOT catalog-style pull cursors — the storage swap is invisible
    // to peers (no schema-version bump). The mirror columns are populated FROM
    // the record body (mirrorTimestamp), not a DB trigger. Mirrors the universes
    // block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS universes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      schema_version INTEGER NOT NULL DEFAULT 4,
      ephemeral BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Partial index on the live set — the common list/scan path is "non-deleted
    // universes". updated_at supports LWW-staleness scans.
    `CREATE INDEX IF NOT EXISTS idx_universes_live ON universes (deleted) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_universes_updated ON universes (updated_at)`,

    // Universe render-history log (issue #1014). The type-level `config.runs[]`
    // array collectionStore kept in data/universes/index.json (capped 200,
    // NEVER federated — per-peer local) becomes its own table. `universe_id` is
    // a soft ref (no FK): the cascade-clean on universe delete is handled in the
    // service exactly as the file backend did, and a soft ref keeps the table
    // independent of universe-row insert ordering during the one-time import.
    // `data` holds jobIds[]/promptCount/collectionId. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS universe_runs (
      id TEXT PRIMARY KEY,
      universe_id TEXT NOT NULL,
      collection_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_universe_runs_universe ON universe_runs (universe_id, created_at DESC)`,

];
