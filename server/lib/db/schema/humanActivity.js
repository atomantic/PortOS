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
];
