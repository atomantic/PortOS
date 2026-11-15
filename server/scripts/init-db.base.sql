-- Hand-written base of server/scripts/init-db.sql — the part ensureSchema()
-- does not own. scripts/generate-init-db-sql.js copies this file and replaces
-- the marker line below with every statement buildUpgradeDdl() and
-- buildCatalogDdl() (server/lib/db/schema/) run at boot, in boot order.
--
-- Only put DDL here that ensureSchema() must NOT run on every boot: the
-- extensions, and the memory system's own tables (memories, memory_links),
-- which are provisioned on fresh installs only (#1337,
-- docs/decisions/2026-04-17-memory-system-local-only.md). An additive table,
-- column or index belongs in a schema module; then run
-- `node scripts/generate-init-db-sql.js`.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Core memories table
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  category VARCHAR(100) DEFAULT 'other',
  tags TEXT[] DEFAULT '{}',
  embedding vector(768),
  embedding_model VARCHAR(100),
  confidence FLOAT DEFAULT 0.8,
  importance FLOAT DEFAULT 0.5,
  access_count INT DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'active',
  source_task_id VARCHAR(100),
  source_agent_id VARCHAR(100),
  source_app_id VARCHAR(100),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Federation sync sequence (auto-incrementing on insert/update)
  sync_sequence BIGSERIAL
);

-- HNSW index for fast vector similarity search (O(log n) instead of O(n))
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Filtered queries
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
CREATE INDEX IF NOT EXISTS idx_memories_source_app ON memories (source_app_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);

-- Memory relationships. Typed (#10493): 'related' is symmetric and stored as a
-- reverse pair; every other link_type is directed and stored as one row.
CREATE TABLE IF NOT EXISTS memory_links (
  source_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  link_type VARCHAR(32) NOT NULL DEFAULT 'related',
  note TEXT,
  created_by VARCHAR(100),
  PRIMARY KEY (source_id, target_id, link_type)
);

-- @portos:schema-modules

-- Needs update_memory_timestamp(), which the schema modules define (core.js).
-- Not in ensureSchema: re-creating it on every boot would take a lock on
-- memories for no change.
DROP TRIGGER IF EXISTS trg_memory_updated_at ON memories;
CREATE TRIGGER trg_memory_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_memory_timestamp();
