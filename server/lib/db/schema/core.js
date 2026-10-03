// Core base-schema DDL — memory sync columns + the versioned db-migration
// tracker. Extracted from ensureSchemaImpl() in server/lib/db.js (#2832) with
// zero behavior change; every statement is idempotent and runs on every boot.
// Parity-locked against server/scripts/init-db.sql by db.ddlParity.test.js.

// Machine-local replay receipts for snapshot database restores (#9725). The
// restore writes one row for its unique operation id INSIDE the replay
// transaction, after the dump, so a lost response or crash at COMMIT is
// resolved from the database instead of guessed. pg_dump excludes its rows
// (they describe this machine's restores, not application data); historical
// receipts can never match a fresh operation id. The restore appends this exact
// statement to its replay, so an older dump that predates the table still gets it.
export const restoreReceiptsDdl = [
    `CREATE TABLE IF NOT EXISTS restore_receipts (
      operation_id UUID PRIMARY KEY,
      dump_sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
];

export const coreDdl = [
    `CREATE TABLE IF NOT EXISTS app_quality_measurements (
      app_id TEXT NOT NULL,
      category TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      assessed_at TIMESTAMPTZ NOT NULL,
      report JSONB NOT NULL,
      PRIMARY KEY (app_id, category, agent_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_quality_history ON app_quality_measurements (app_id, assessed_at DESC)`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS sync_sequence BIGSERIAL`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_instance_id VARCHAR(36)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_origin_instance ON memories (origin_instance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_sync_sequence ON memories (sync_sequence)`,
    // Versioned DB-migration tracker (#1029). Records which ordered migration
    // files in server/scripts/db-migrations/ have been applied on THIS install.
    // It's part of the base schema (created here AND in init-db.sql, parity-
    // locked by db.ddlParity.test.js) so the runner — which executes
    // AFTER ensureSchema() at boot — can always read it. ensureSchema()'s
    // additive CREATE/ADD IF NOT EXISTS gates handle fresh-install schema; the
    // runner handles DELTAS that those gates can't express (renames, type
    // changes, data transforms, embedding-dimension changes).
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    ...restoreReceiptsDdl,
];
