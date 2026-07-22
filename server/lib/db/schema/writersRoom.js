// Writers-Room DDL — folders, works, draft versions, and exercises. Extracted
// verbatim from ensureSchemaImpl() in server/lib/db.js (#2832); idempotent,
// runs on every boot.
export const writersRoomDdl = [
    // Folder tree. Self-ref parent_id (soft, no FK — nested tree). sort_order +
    // name promoted (the library renders the tree ordered by them). Mirrors
    // init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_folders_parent ON writers_room_folders (parent_id, sort_order)`,
    // Idempotent upgrade for installs predating folder federation (#1645): without
    // the soft-delete columns an old install boots the new code and hard-DELETEs a
    // folder (no tombstone) — peers never learn it was removed and resurrect it.
    `ALTER TABLE writers_room_folders ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE writers_room_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,

    // Work manifests. The drafts[] array moves OUT of `data` into
    // writers_room_draft_versions (the one decomposition — draft versions are a
    // genuine 1-to-many the library + Phase-5 staleness analysis query). imageStyle
    // / liveMode / usage counters stay in `data`. `folder_id`, `title`, `kind`,
    // `status`, the promote/bridge links, and `active_draft_version_id` are
    // promoted for the library list + the resolver (#1018) + the bridge CTAs.
    // SOFT-DELETE added here (`deleted`/`deleted_at`): the file backend hard-deletes
    // via rm -rf; the DB backend aligns with the other stores (import sets
    // deleted = FALSE for all existing works). Soft ref everywhere — no FK.
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_works (
      id TEXT PRIMARY KEY,
      folder_id TEXT,
      title TEXT NOT NULL,
      kind VARCHAR(32),
      status VARCHAR(32),
      active_draft_version_id TEXT,
      pipeline_series_id TEXT,
      pipeline_issue_id TEXT,
      cd_project_id TEXT,
      media_collection_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_works_folder ON writers_room_works (folder_id) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_wr_works_series ON writers_room_works (pipeline_series_id) WHERE pipeline_series_id IS NOT NULL`,

    // Draft-version metadata index (file-primary bodies). The .md body stays on
    // disk at data/writers-room/works/<workId>/drafts/<draftId>.md; this row is
    // the queryable index over it: `content_file` (relative path), `content_hash`
    // (sha256 for staleness), `word_count`, `segment_index` (outline), version
    // lineage. asset-file-db-indexed pattern applied to prose. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_draft_versions (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      label TEXT,
      content_file TEXT NOT NULL,
      content_hash TEXT,
      word_count INTEGER DEFAULT 0,
      segment_index JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_from_version_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_drafts_work ON writers_room_draft_versions (work_id, created_at)`,

    // Exercise sessions (sprint timer). Monolithic exercises.json → flat table.
    // `work_id`, `status`, started_at promoted for the per-work list (ordered by
    // started_at DESC). prompt/durations/word counts/appendedText stay in `data`.
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_exercises (
      id TEXT PRIMARY KEY,
      work_id TEXT,
      status VARCHAR(16),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_exercises_work ON writers_room_exercises (work_id, started_at DESC)`,
    // Idempotent upgrade for installs predating exercise federation (#1645). The
    // tombstone columns let a peer's deletion propagate (LWW never propagates a
    // hard delete); no current path deletes an exercise but a future peer might.
    `ALTER TABLE writers_room_exercises ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE writers_room_exercises ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,

];
