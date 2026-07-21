// Pipeline DDL — comic/prose pipeline series, issues, and story-builder
// sessions. Extracted verbatim from ensureSchemaImpl() in server/lib/db.js
// (#2832); idempotent, runs on every boot.
export const pipelineDdl = [
    // Pipeline series (Phase 3 Create migration, issue #1015). One row per
    // series, the full sanitized record (arc/seasons/locks/covers/style) in
    // `data` JSONB, moved out of data/pipeline-series/{id}/index.json
    // (collectionStore). Only the fields the service/federation query, join, or
    // sort on are mirrored into columns: `name` (rename-cascade + list sort),
    // `universe_id` (the hot relationship — the delete-guard "reject universe
    // delete when live series link it" + "series in this universe" lists; soft
    // ref, no FK — a series can sync before its universe arrives), and the
    // promote back-link `writers_room_work_id`. `ephemeral` + the LWW/tombstone
    // trio (updated_at/deleted/deleted_at) populated FROM the record body
    // (mirrorTimestamp), not a DB trigger. NO sync_sequence: pipeline records
    // federate via the EXISTING dataSync snapshot/push model — the storage swap
    // is invisible to peers (no schema-version bump). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS pipeline_series (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      universe_id TEXT,
      writers_room_work_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      ephemeral BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_series_universe ON pipeline_series (universe_id) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_series_wr_work ON pipeline_series (writers_room_work_id)`,
    `CREATE INDEX IF NOT EXISTS idx_series_updated ON pipeline_series (updated_at)`,

    // Pipeline issues (issue #1015). One row per issue; the 8-stage `stages`
    // map (text/visual/audio, runHistory, canonExtraction, covers) + lastRunId
    // pointers stay entirely in `data` JSONB (document-shaped, sanitizer-owned).
    // `series_id` (parent, soft ref), `season_id` (arc grouping), and `number`
    // (renumber-recomputed ordinal) are promoted — the renumber pass reads all
    // issues of a series ordered by number, the single most common cross-record
    // pipeline query, served directly by idx_issues_series (series_id, number).
    // `status` promoted for "issues needing review" dashboards. `ephemeral` +
    // LWW/tombstone trio mirror the body. NO sync_sequence (see pipeline_series).
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS pipeline_issues (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      season_id TEXT,
      number INTEGER,
      status VARCHAR(32),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      ephemeral BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_issues_series ON pipeline_issues (series_id, number) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_issues_season ON pipeline_issues (season_id) WHERE season_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_issues_updated ON pipeline_issues (updated_at)`,

    // Story Builder sessions (issue #1016). One row per session; the conductor
    // bookkeeping (`steps` lock/integrity map, `syncedHashes` baseline,
    // `currentStep`, `llm` picker choice) stays entirely in `data` JSONB. The two
    // FKs `universe_id` / `series_id` are promoted for "sessions linked to this
    // record" lookups. `sync` is promoted because Story Builder is the one store
    // whose federation is OPT-IN — the snapshot loop filters WHERE sync = TRUE to
    // decide what to even consider pushing, so promoting it avoids deserializing
    // every session's `data` per snapshot tick. `ephemeral` + the LWW/tombstone
    // trio mirror the body. NO sync_sequence (sessions ride the existing dataSync
    // snapshot/LWW model, not the per-record push pipeline). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS story_builder_sessions (
      id TEXT PRIMARY KEY,
      universe_id TEXT,
      series_id TEXT,
      sync BOOLEAN DEFAULT FALSE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      ephemeral BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stb_universe ON story_builder_sessions (universe_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stb_series ON story_builder_sessions (series_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stb_updated ON story_builder_sessions (updated_at)`,

    // Writers Room (Phase 3 Create migration, issue #1017). FOUR tables replace
    // the bespoke file layout (folders.json, exercises.json, per-work
    // manifest.json). Writers Room is NOT federated — it has no dataSync category
    // and no schema-version gate — so unlike the universe/pipeline/story-builder
    // tables these carry NO `ephemeral`/`sync`/sync_sequence columns and need no
    // mutation epoch. The only thing that stays on disk is the draft prose body
    // (drafts/<draftId>.md, file-primary); its metadata is the draft_versions row.

];
