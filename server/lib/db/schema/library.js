// Creative-library DDL — authors, artists, albums, and tracks. Extracted
// verbatim from ensureSchemaImpl() in server/lib/db.js (#2832); idempotent,
// runs on every boot.
export const libraryDdl = [
    // Author personas. One row per reusable author/byline persona, the full
    // sanitized record (name, writingStyle, bio, physicalDescription,
    // headshotStyle, headshotImageUrl) in `data` JSONB. `name` mirrors a column
    // for the live-list sort; the LWW/tombstone trio (updated_at/deleted/
    // deleted_at) is populated FROM the record body. Authors are db-primary AND
    // federated via the per-record peer-sync push pipeline (record kind `author`,
    // sync category `authors`); a federated series also keeps its denormalized
    // `author` byline so a peer that hasn't synced the persona still renders the
    // cover correctly. Mirrors the authors block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_authors_live ON authors (deleted) WHERE deleted = FALSE`,

    // Music artists (the Music studio's persona store — analogue of authors).
    // One row per artist, the full sanitized record (name, genre, bio,
    // musicalStyle, physicalDescription, portraitStyle, portraitImageUrl) in
    // `data` JSONB. `name` mirrors a column for the live-list sort; the LWW/
    // tombstone trio is populated FROM the record body. Artists are db-primary
    // and federation-ready (LWW merge mirrors authors), but the artist record
    // kind is not yet registered in peerSync — local-only for now (see issue #1502).
    // Mirrors the artists block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_artists_live ON artists (deleted) WHERE deleted = FALSE`,

    // Music albums (the Music studio). One row per album, the full sanitized
    // record (title, artistId+denormalized artist, description, genre,
    // releaseYear, coverImageUrl, ordered trackIds) in `data` JSONB. `title`
    // mirrors a column for the live-list sort. db-primary + federation-ready
    // (LWW merge mirrors artists), not yet registered in peerSync — local-only
    // for now (see issue #1502). Mirrors the albums block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_albums_live ON albums (deleted) WHERE deleted = FALSE`,

    // Music tracks (the Music studio). One row per track, the full sanitized
    // record (title, albumId/artistId FKs + denormalized artist, lyrics, prompt,
    // engine/modelId/durationSec gen metadata, audioFilename pointing into the
    // shared music library at data/music/) in `data` JSONB. `title` mirrors a
    // column for queries. db-primary + federation-ready, not yet registered in
    // peerSync — local-only for now (see issue #1502). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_live ON tracks (deleted) WHERE deleted = FALSE`,

];
