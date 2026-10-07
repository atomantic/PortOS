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

// Local history also captures current-row replacements arriving through federation.
export const memoryHistoryDdl = [
    `ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid()`,
    `ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS link_type VARCHAR(32) NOT NULL DEFAULT 'related'`,
    `ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS note TEXT`,
    `ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS created_by VARCHAR(100)`,
    `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'memory_links'::regclass AND c.contype = 'p' AND a.attname = 'link_type'
  ) THEN
    ALTER TABLE memory_links DROP CONSTRAINT memory_links_pkey;
    ALTER TABLE memory_links ADD PRIMARY KEY (source_id, target_id, link_type);
  END IF;
END$$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_id ON memory_links (id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links (target_id)`,

    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_reason TEXT`,
    `CREATE TABLE IF NOT EXISTS memory_versions (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  type VARCHAR(20) NOT NULL,
  category VARCHAR(100),
  tags TEXT[],
  changed_by VARCHAR(100),
  change_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, version)
)`,
    `CREATE OR REPLACE FUNCTION record_memory_version() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(OLD.content, OLD.summary, OLD.type, OLD.category, OLD.tags)
     IS DISTINCT FROM ROW(NEW.content, NEW.summary, NEW.type, NEW.category, NEW.tags) THEN
    INSERT INTO memory_versions
      (memory_id, version, content, summary, type, category, tags, changed_by, change_reason)
    VALUES (OLD.id, OLD.version, OLD.content, OLD.summary, OLD.type, OLD.category, OLD.tags,
      NULLIF(current_setting('portos.memory_changed_by', true), ''),
      NULLIF(current_setting('portos.memory_change_reason', true), ''));
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'memories'::regclass AND tgname = 'memory_version_history') THEN
    CREATE TRIGGER memory_version_history BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION record_memory_version();
  END IF;
END$$`,
];

export const coreDdl = [
    ...memoryHistoryDdl,
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
