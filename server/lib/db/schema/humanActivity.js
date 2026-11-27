// Human activity timeline DDL (#2150) — unified machine-local event store fed
// by message/calendar syncs. Extracted verbatim from ensureSchemaImpl() in
// server/lib/db.js (#2832); idempotent, runs on every boot.
export const humanActivityDdl = [
    // Unified, machine-local event store fed by message/calendar syncs. Metadata + a short summary
    // only; full bodies stay in per-source caches. Idempotent via the unique (source, dedupe_key)
    // index + ON CONFLICT DO NOTHING. Excluded from peer sync (ADR 2026-06-26), guarded in
    // peerSync.test.js.
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
    // Source-scoped timeline reads (#5715): `WHERE source = $1 [AND kind = ...] ORDER BY
    // happened_at DESC LIMIT n` (listEvents) is served by neither index above (dedupe has no
    // ordering; happened_at must filter every row on source). Two indexes because
    // `(source, kind, happened_at)` doesn't efficiently serve the source-only query.
    //
    // Deliberately NOT `CONCURRENTLY`: ensureSchema() runs inside the boot sequence, where
    // CREATE INDEX CONCURRENTLY cannot run in a transaction block.
    `CREATE INDEX IF NOT EXISTS idx_human_activity_source_happened ON human_activity_events (source, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_source_kind_happened ON human_activity_events (source, kind, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_happened_id ON human_activity_events (happened_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_participants ON human_activity_events USING gin (participants jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_human_activity_account_happened ON human_activity_events (account_id, happened_at DESC) WHERE account_id IS NOT NULL`,
];
