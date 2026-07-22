// Core base-schema DDL — memory sync columns + the versioned db-migration
// tracker. Extracted from ensureSchemaImpl() in server/lib/db.js (#2832) with
// zero behavior change; every statement is idempotent and runs on every boot.
// Parity-locked against server/scripts/init-db.sql by db.catalogDdlParity.test.js.
export const coreDdl = [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS sync_sequence BIGSERIAL`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_instance_id VARCHAR(36)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_origin_instance ON memories (origin_instance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_sync_sequence ON memories (sync_sequence)`,
    // Versioned DB-migration tracker (#1029). Records which ordered migration
    // files in server/scripts/db-migrations/ have been applied on THIS install.
    // It's part of the base schema (created here AND in init-db.sql, parity-
    // locked by db.catalogDdlParity.test.js) so the runner — which executes
    // AFTER ensureSchema() at boot — can always read it. ensureSchema()'s
    // additive CREATE/ADD IF NOT EXISTS gates handle fresh-install schema; the
    // runner handles DELTAS that those gates can't express (renames, type
    // changes, data transforms, embedding-dimension changes).
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`,
];
