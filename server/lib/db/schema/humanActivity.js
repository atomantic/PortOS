// Human activity timeline DDL (#2150) — unified machine-local event store fed
// by message/calendar syncs. Extracted verbatim from ensureSchemaImpl() in
// server/lib/db.js (#2832); idempotent, runs on every boot.
export const humanActivityDdl = [
    // Human activity timeline (#2150) — unified, machine-local event store fed by
    // message/calendar syncs (later: iMessage, Spotify, YouTube, Signal). Stores
    // metadata + a short summary only; full bodies stay in per-source caches, with
    // metadata pointers (threadId/externalId) back to the source. Idempotent via the
    // unique (source, dedupe_key) index + ON CONFLICT DO NOTHING. Machine-local like
    // Tribe (ADR 2026-06-26) — excluded from peer sync, guarded in peerSync.test.js.
    `CREATE TABLE IF NOT EXISTS human_activity_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      account_id TEXT,
      kind TEXT NOT NULL,
      happened_at TIMESTAMPTZ NOT NULL,
      duration_s INTEGER,
      title TEXT,
      summary TEXT,
      url TEXT,
      participants JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_human_activity_dedupe ON human_activity_events (source, dedupe_key)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_happened ON human_activity_events (happened_at)`,
    // Source-scoped timeline reads (#5715). The dominant shape is
    // `WHERE source = $1 [AND kind = ...] ORDER BY happened_at DESC LIMIT n`
    // (listEvents in services/humanActivity.js), which neither index above
    // serves: the dedupe index leads on `source` but carries no ordering, and
    // the `happened_at` index orders but must filter every row on `source` — so
    // a low-volume source behind a high-volume one walks past a large number of
    // non-matching rows before it can fill LIMIT. Two indexes, not one: the
    // kind-filtered read is a distinct shape, and `(source, kind, happened_at)`
    // does not efficiently serve the source-only query for a source with many
    // kinds. Mirrors the composites `user_action_events` already ships.
    //
    // Deliberately NOT `CONCURRENTLY`: ensureSchema() runs this DDL as part of
    // the boot sequence, and CREATE INDEX CONCURRENTLY cannot run inside a
    // transaction block. The table is machine-local and the boot-time build is
    // bounded, so the blocking build is the correct trade here.
    `CREATE INDEX IF NOT EXISTS idx_human_activity_source_happened ON human_activity_events (source, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_source_kind_happened ON human_activity_events (source, kind, happened_at DESC)`,
];
