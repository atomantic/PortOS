// Media-project DDL — creative-director projects, music-video projects, mood
// boards, and media assets. Extracted verbatim from ensureSchemaImpl() in
// server/lib/db.js (#2832); idempotent, runs on every boot.
export const mediaDdl = [
    // Creative Director projects (Phase 3, issue #997). One row per project;
    // the full record lives in `data` JSONB, with status/created_at/updated_at
    // mirrored into columns (kept in lockstep on every write) for future
    // queries. `listProjects` sorts by created_at. `status` is app-layer gated
    // (PROJECT_STATUSES), no DB CHECK. As of #1564 projects FEDERATE across peers
    // via the per-record peer-sync push pipeline (record kind
    // `creativeDirectorProject`, sync category `creativeDirectorProjects`), so
    // the soft-delete tombstone trio (deleted/deleted_at + LWW updated_at) mirrors
    // the authors table — a delete is a tombstone the merge keeps an out-of-date
    // peer from resurrecting. Mirrors the creative_director_projects block in
    // init-db.sql; the ADD COLUMN upgrades below backfill existing installs.
    `CREATE TABLE IF NOT EXISTS creative_director_projects (
      id TEXT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Backfill the tombstone columns on installs created before #1564 (the
    // CREATE above is a no-op once the table exists). The partial index serves
    // the live-list filter (deleted = FALSE).
    `ALTER TABLE creative_director_projects ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE creative_director_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_creative_director_projects_live ON creative_director_projects (deleted) WHERE deleted = FALSE`,

    // Music Video projects (issue #1760). The director scene board's db-primary
    // record: id/status/created_at/updated_at mirrored as columns, the full
    // project (track link, cached audioAnalysis, scenes[]) in `data` JSONB —
    // same shape as creative_director_projects. The soft-delete tombstone trio is
    // present so peer-sync federation (a follow-up) is additive. Mirrors the
    // music_video_projects block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS music_video_projects (
      id TEXT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `ALTER TABLE music_video_projects ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE music_video_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_music_video_projects_live ON music_video_projects (deleted) WHERE deleted = FALSE`,

    // Mood boards (issue #911). A dedicated inspiration/mood-board canvas,
    // distinct from raw Media History, for collecting visual + textual
    // references that feed the Create suite. One row per board, the full record
    // (name/description/items[]) in `data` JSONB. Items (image-by-media-key or
    // external URL, or a text note + optional caption/source backref) live
    // inline in the board's JSONB rather than a child table — a board is read/
    // written whole, has a small bounded item list, and there are no cross-board
    // item queries. `name` mirrors a column for the live-list sort. As of #1564
    // mood boards FEDERATE across peers via the per-record peer-sync push pipeline
    // (record kind `moodBoard`, sync category `moodBoards`), so the soft-delete
    // tombstone trio (deleted/deleted_at + LWW updated_at) mirrors
    // creative_director_projects — a delete is a tombstone the merge keeps an
    // out-of-date peer from resurrecting. Mirrors the mood_boards block in
    // init-db.sql; the ADD COLUMN upgrades below backfill existing installs.
    `CREATE TABLE IF NOT EXISTS mood_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Backfill the tombstone columns on installs created before #1564 (the
    // CREATE above is a no-op once the table exists).
    `ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    // updated_at DESC is the board-list "recently touched" sort.
    `CREATE INDEX IF NOT EXISTS idx_mood_boards_updated ON mood_boards (updated_at DESC)`,
    // Partial index for the live-list filter (deleted = FALSE).
    `CREATE INDEX IF NOT EXISTS idx_mood_boards_live ON mood_boards (deleted) WHERE deleted = FALSE`,

    // Media asset index (Phase 3.2, issue #1000). One row per generated image
    // or video; the bytes stay on disk (data/images, data/videos) and the
    // sidecar/.json history files remain authoritative — this table is a
    // DERIVED, queryable index, reconciled from disk at boot + kept warm by a
    // generation-completed hook. `media_key` is the shared `<kind>:<ref>`
    // vocabulary (mediaItemKey.js); `kind`/`ref` are mirrored into columns for
    // queries, the full metadata record lives in `data` JSONB. created_at is
    // the asset's own timestamp; indexed_at is when this index row was written.
    // No sync_sequence/tombstone: the index is local-only (rebuilt from disk),
    // not federated — a row vanishes when its file does (prune on reconcile).
    // Mirrors the media_assets block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS media_assets (
      media_key TEXT PRIMARY KEY,
      kind VARCHAR(16) NOT NULL,
      ref TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      indexed_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // created_at DESC is the gallery/history sort order; kind narrows
    // images-vs-videos. A composite (kind, created_at DESC) serves both.
    `CREATE INDEX IF NOT EXISTS idx_media_assets_kind_created ON media_assets (kind, created_at DESC)`,

];
