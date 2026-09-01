// Operator-action ledger DDL (#5594, epic #5593) — the durable, filterable
// record of what the human actually did in PortOS (queued a CoS task, rated an
// agent run, hit Run Now on a schedule, changed settings).
//
// Machine-local like `human_activity_events`: excluded from peer sync, guarded
// in sharing/peerSync.test.js. Idempotent via the unique (type, dedupe_key)
// index + ON CONFLICT DO NOTHING, so a retried request records once.
//
// Deliberately NOT in `auditedTables` (server/lib/db/schema/audit.js) — this is
// a personal operator log, same rationale as `post_runs`; auditing an audit log
// doubles every row for no recoverable value.
export const userActionsDdl = [
    `CREATE TABLE IF NOT EXISTS user_action_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      happened_at TIMESTAMPTZ NOT NULL,
      target TEXT,
      target_name TEXT,
      success BOOLEAN NOT NULL DEFAULT TRUE,
      summary TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      source JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_action_dedupe ON user_action_events (type, dedupe_key)`,
    `CREATE INDEX IF NOT EXISTS idx_user_action_happened ON user_action_events (happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_user_action_type_time ON user_action_events (type, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_user_action_actor_time ON user_action_events (actor, happened_at DESC)`,
];
