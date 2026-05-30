-- PortOS Memory System Schema
-- PostgreSQL + pgvector

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

-- Schema upgrades: add columns that may not exist on older installs
ALTER TABLE memories ADD COLUMN IF NOT EXISTS sync_sequence BIGSERIAL;

-- Origin instance tracking for federation
ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_instance_id VARCHAR(36);
CREATE INDEX IF NOT EXISTS idx_memories_origin_instance ON memories (origin_instance_id);

-- HNSW index for fast vector similarity search (O(log n) instead of O(n))
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search index (replaces BM25)
CREATE INDEX IF NOT EXISTS idx_memories_fts
  ON memories USING gin (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, ''))
  );

-- Filtered queries
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
CREATE INDEX IF NOT EXISTS idx_memories_source_app ON memories (source_app_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);

-- Sync sequence index for federation
CREATE INDEX IF NOT EXISTS idx_memories_sync_sequence ON memories (sync_sequence);

-- Memory relationships (bidirectional links)
CREATE TABLE IF NOT EXISTS memory_links (
  source_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

-- Auto-update updated_at and sync_sequence on content/metadata changes.
-- Skips bump for access-stat-only updates (access_count, last_accessed)
-- to avoid sync noise from read operations.
-- Respects explicitly provided updated_at (e.g., from sync service).
CREATE OR REPLACE FUNCTION update_memory_timestamp()
RETURNS TRIGGER AS $$
DECLARE
  content_changed BOOLEAN;
BEGIN
  content_changed := (
    NEW.type IS DISTINCT FROM OLD.type OR
    NEW.content IS DISTINCT FROM OLD.content OR
    NEW.summary IS DISTINCT FROM OLD.summary OR
    NEW.category IS DISTINCT FROM OLD.category OR
    NEW.tags IS DISTINCT FROM OLD.tags OR
    NEW.embedding IS DISTINCT FROM OLD.embedding OR
    NEW.embedding_model IS DISTINCT FROM OLD.embedding_model OR
    NEW.confidence IS DISTINCT FROM OLD.confidence OR
    NEW.importance IS DISTINCT FROM OLD.importance OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
    NEW.source_task_id IS DISTINCT FROM OLD.source_task_id OR
    NEW.source_agent_id IS DISTINCT FROM OLD.source_agent_id OR
    NEW.source_app_id IS DISTINCT FROM OLD.source_app_id OR
    NEW.updated_at IS DISTINCT FROM OLD.updated_at
  );

  -- Access-stat-only update: skip sync_sequence and updated_at bump
  IF NOT content_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  NEW.sync_sequence := nextval(pg_get_serial_sequence('memories', 'sync_sequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_updated_at ON memories;
CREATE TRIGGER trg_memory_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_memory_timestamp();

-- ============================================================================
-- Creative Ingredients Catalog
-- ============================================================================
-- Typed, tagged, embeddable store for creative "ingredients" (characters,
-- places, objects, ideas, scenes, concepts) extracted from user-pasted scraps.
-- Cross-references universes/series/issues/works via catalog_ingredient_refs.
-- Federates via sync_sequence BIGSERIAL + LWW on updated_at (same pattern as
-- the memories table above).

-- Raw user input preserved verbatim. One scrap can spawn many ingredients.
CREATE TABLE IF NOT EXISTS catalog_scraps (
  id TEXT PRIMARY KEY,                         -- 'cat-scrap-<uuid>'
  title TEXT,
  raw_text TEXT NOT NULL,
  source_kind VARCHAR(32) DEFAULT 'paste',     -- paste|brain-bridge|importer-handoff
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding vector(768),
  embedding_model VARCHAR(100),
  origin_instance_id VARCHAR(36),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_embedding
  ON catalog_scraps USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_fts
  ON catalog_scraps USING gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(raw_text, ''))
  );
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_sync_seq ON catalog_scraps (sync_sequence);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_created_at ON catalog_scraps (created_at);
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_origin_instance ON catalog_scraps (origin_instance_id);

-- Extracted, structured ingredients. Char/place/object payloads follow the
-- shape sanitized by server/lib/storyBible.js so backfill and fresh ingest
-- produce identical records. Idea/scene/concept payloads are lighter shapes.
CREATE TABLE IF NOT EXISTS catalog_ingredients (
  id TEXT PRIMARY KEY,                         -- 'cat-chr-<uuid>', 'cat-plc-<uuid>', etc.
  type VARCHAR(20) NOT NULL
    CHECK (type IN ('character', 'place', 'object', 'idea', 'scene', 'concept')),
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] DEFAULT '{}',
  embedding vector(768),
  embedding_model VARCHAR(100),
  origin_instance_id VARCHAR(36),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL
);
-- Weighted FTS column. Name carries the most weight (A); the character canon
-- fields (description, physicalDescription, personality, background, summary,
-- notes) plus the role/motivations/significance type-specific fields fall under
-- B. Generated/stored so the GIN index stays fresh without trigger code.
-- Postgres can't ALTER the expression of a STORED generated column, so when
-- the v2 expansion needs to land we DROP and re-ADD the column. The DO block
-- below inspects pg_attrdef and only drops when the existing expression is
-- missing a v2-only field (`physicalDescription`) — fresh runs of this script
-- skip the drop entirely (column absent), already-v2 installs skip it too, and
-- only an upgrading v1 install pays the table-rewrite cost. ensureSchema in
-- server/lib/db.js mirrors the same gate. PORTOS_SCHEMA_VERSIONS.catalog is
-- bumped to 2 in lockstep so older peers can't push pre-expansion-shape rows
-- that would mismatch the indexed expression.
DO $$
  DECLARE
    expr TEXT;
  BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO expr
      FROM pg_attribute a
      JOIN pg_attrdef  d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'catalog_ingredients'::regclass
       AND a.attname  = 'search_tsv'
       AND a.attgenerated = 's';
    IF expr IS NOT NULL AND position('physicalDescription' in expr) = 0 THEN
      EXECUTE 'ALTER TABLE catalog_ingredients DROP COLUMN search_tsv';
    END IF;
  END$$;
ALTER TABLE catalog_ingredients ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(payload->>'description', '') || ' ' ||
      coalesce(payload->>'physicalDescription', '') || ' ' ||
      coalesce(payload->>'personality', '') || ' ' ||
      coalesce(payload->>'background', '') || ' ' ||
      coalesce(payload->>'summary', '') || ' ' ||
      coalesce(payload->>'notes', '') || ' ' ||
      coalesce(payload->>'role', '') || ' ' ||
      coalesce(payload->>'motivations', '') || ' ' ||
      coalesce(payload->>'significance', '')
    ), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_catalog_ing_embedding
  ON catalog_ingredients USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_fts ON catalog_ingredients USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_type ON catalog_ingredients (type);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_tags ON catalog_ingredients USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_sync_seq ON catalog_ingredients (sync_sequence);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_created_at ON catalog_ingredients (created_at);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_origin_instance ON catalog_ingredients (origin_instance_id);

-- Provenance: which scrap(s) an ingredient was extracted from.
-- A single ingredient may be reinforced by multiple scraps over time.
CREATE TABLE IF NOT EXISTS catalog_ingredient_sources (
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  scrap_id TEXT NOT NULL REFERENCES catalog_scraps(id) ON DELETE CASCADE,
  span JSONB,                                  -- optional { start, end } char range in raw_text
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  sync_sequence BIGSERIAL,
  PRIMARY KEY (ingredient_id, scrap_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_sources_scrap ON catalog_ingredient_sources (scrap_id);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_sources_sync_seq ON catalog_ingredient_sources (sync_sequence);

-- Consumption: which universe/series/issue/work/etc references this ingredient.
-- Drives the "Appears in" panel on the ingredient detail page and the
-- back-reference count on the catalog list.
CREATE TABLE IF NOT EXISTS catalog_ingredient_refs (
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  ref_kind VARCHAR(32) NOT NULL,               -- 'universe'|'series'|'issue'|'work'|'creative-director'
  ref_id TEXT NOT NULL,
  role VARCHAR(64) NOT NULL,                   -- 'canon-character'|'canon-place'|'canon-object'|'cast'|'mentioned'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so unlinks propagate to peers
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL,
  PRIMARY KEY (ingredient_id, ref_kind, ref_id, role)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_refs_target ON catalog_ingredient_refs (ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_refs_sync_seq ON catalog_ingredient_refs (sync_sequence);

-- Ingredient↔ingredient edges — the seam that makes the catalog a graph
-- instead of a flat list. `kind` is an app-layer enum (RELATION_KINDS in
-- server/lib/catalogTypes.js): 'appears-in'|'lives-in'|'created-by'|
-- 'parent-of'|'variant-of'|'references'|'related-to'. Both ids FK to
-- catalog_ingredients(id) ON DELETE CASCADE so deleting an ingredient
-- (hard-delete) cleans up its edges. Soft-delete (deleted/deleted_at) from day
-- one so unlinks propagate to peers as tombstones — same lesson as the refs
-- table. Directed edge: from_id → to_id (the inverse direction is rendered in
-- the UI from the same row, not stored twice).
CREATE TABLE IF NOT EXISTS catalog_ingredient_relations (
  from_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,                   -- relation kind from RELATION_KINDS
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so unlinks propagate to peers
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_relations_to ON catalog_ingredient_relations (to_id);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_relations_sync_seq ON catalog_ingredient_relations (sync_sequence);

-- First-class canonical tag table. The freeform `catalog_ingredients.tags
-- TEXT[]` column stays as-is for write-path simplicity; this table is an
-- additive index that the normalizer (catalogDB.normalizeTags) populates on
-- first use of a tag. `id` is deterministic (`cat-tag-<canonical-key>`) so the
-- same logical tag has the same id on every install. `parent_id` is an optional
-- self-FK enabling tag hierarchies (genre/tone vs structural). Federates via
-- sync_sequence BIGSERIAL + LWW on created_at (tags are append-mostly; the
-- mutable fields — label/description/color/parent_id — round-trip through the
-- trigger below). `ON DELETE SET NULL` on the parent self-FK keeps orphaned
-- children rather than cascading a whole subtree away.
CREATE TABLE IF NOT EXISTS catalog_tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,                         -- canonical display label (first-seen casing)
  description TEXT,
  color VARCHAR(32),
  parent_id TEXT REFERENCES catalog_tags(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_sequence BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_catalog_tags_label ON catalog_tags (label);
CREATE INDEX IF NOT EXISTS idx_catalog_tags_parent ON catalog_tags (parent_id);
CREATE INDEX IF NOT EXISTS idx_catalog_tags_sync_seq ON catalog_tags (sync_sequence);

-- Append-only revision history for catalog_ingredients. A row is written by
-- catalogDB.updateIngredient whenever name/payload/tags actually change (and a
-- seed row on create), so the detail page can show "what changed" and offer a
-- Restore button. `source` records WHO/WHAT drove the change ('user' edit,
-- 'extract' ingest commit, 'refine' AI pass, 'sync' peer apply); `actor` is an
-- optional free label (agent run id, provider name). Keyed (ingredient_id,
-- created_at) for the per-ingredient timeline query. Retention is capped at the
-- last N per ingredient by the app layer (CATALOG_REVISION_RETENTION, default
-- 50) -- older rows are pruned on each write to bound growth.
--
-- LOCAL audit history: revisions do NOT carry a sync_sequence and are NOT
-- federated. Each install records its own edit timeline; the synced
-- catalog_ingredients row already LWW-merges the latest state across peers, so
-- replicating per-edit history would multiply rows without a restore use case
-- on the receiving peer. (If revisions ever need to federate, add a
-- sync_sequence BIGSERIAL + a getChangesSince path and bump
-- PORTOS_SCHEMA_VERSIONS.catalog.)
CREATE TABLE IF NOT EXISTS catalog_ingredient_revisions (
  id TEXT PRIMARY KEY,
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] DEFAULT '{}',
  source VARCHAR(16) NOT NULL DEFAULT 'user'
    CHECK (source IN ('user', 'extract', 'refine', 'sync')),
  actor VARCHAR(120),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_revisions_ingredient
  ON catalog_ingredient_revisions (ingredient_id, created_at DESC);

-- Typed media attachments for an ingredient (a generated portrait, a mood /
-- reference image, a recorded voice memo, …). `media_key` is a REFERENCE into
-- this install's media library (data/images + the history.jsonl sidecar /
-- generated assets) — the bytes are NEVER duplicated here, so federation ships
-- the key and the receiver matches it against its OWN library (a missing match
-- surfaces via the metadata-missing integrity endpoint rather than failing the
-- sync). `kind` is an app-layer enum (MEDIA_KINDS in catalogTypes.js), not a DB
-- CHECK, so a newer peer's extra kind stores harmlessly. Soft-delete
-- (deleted/deleted_at) from day one so detaches tombstone + propagate to peers
-- — same lesson as the refs/relations tables. PK is (ingredient_id, media_key,
-- kind): the same asset can ride as both a portrait and a reference, but not
-- twice as the same kind.
CREATE TABLE IF NOT EXISTS catalog_ingredient_media (
  ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,                     -- filename/key into the media library; not an FK
  kind VARCHAR(32) NOT NULL,                   -- portrait|reference|audio|video|document (MEDIA_KINDS)
  role VARCHAR(64),                            -- optional free label (e.g. 'hero-shot', 'angry')
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so detaches propagate to peers
  deleted_at TIMESTAMPTZ,
  sync_sequence BIGSERIAL,
  PRIMARY KEY (ingredient_id, media_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_ingredient ON catalog_ingredient_media (ingredient_id);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_key ON catalog_ingredient_media (media_key);
CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_sync_seq ON catalog_ingredient_media (sync_sequence);

-- Auto-update updated_at and bump sync_sequence on content/metadata changes.
-- Mirrors update_memory_timestamp's pattern: skip the bump on no-content-change
-- so cosmetic touches don't trigger sync. Respects explicit updated_at (used by
-- the sync apply path to preserve the originating timestamp during LWW merges).
CREATE OR REPLACE FUNCTION update_catalog_ingredient_timestamp()
RETURNS TRIGGER AS $$
DECLARE
  content_changed BOOLEAN;
BEGIN
  content_changed := (
    NEW.type IS DISTINCT FROM OLD.type OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.payload IS DISTINCT FROM OLD.payload OR
    NEW.tags IS DISTINCT FROM OLD.tags OR
    NEW.embedding IS DISTINCT FROM OLD.embedding OR
    NEW.embedding_model IS DISTINCT FROM OLD.embedding_model OR
    NEW.deleted IS DISTINCT FROM OLD.deleted OR
    NEW.updated_at IS DISTINCT FROM OLD.updated_at
  );

  IF NOT content_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredients', 'sync_sequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_ingredient_updated_at ON catalog_ingredients;
CREATE TRIGGER trg_catalog_ingredient_updated_at
  BEFORE UPDATE ON catalog_ingredients
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_ingredient_timestamp();

CREATE OR REPLACE FUNCTION update_catalog_scrap_timestamp()
RETURNS TRIGGER AS $$
DECLARE
  content_changed BOOLEAN;
BEGIN
  content_changed := (
    NEW.title IS DISTINCT FROM OLD.title OR
    NEW.raw_text IS DISTINCT FROM OLD.raw_text OR
    NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
    NEW.metadata IS DISTINCT FROM OLD.metadata OR
    NEW.embedding IS DISTINCT FROM OLD.embedding OR
    NEW.embedding_model IS DISTINCT FROM OLD.embedding_model OR
    NEW.deleted IS DISTINCT FROM OLD.deleted OR
    NEW.updated_at IS DISTINCT FROM OLD.updated_at
  );

  IF NOT content_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_scraps', 'sync_sequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_scrap_updated_at ON catalog_scraps;
CREATE TRIGGER trg_catalog_scrap_updated_at
  BEFORE UPDATE ON catalog_scraps
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_scrap_timestamp();

-- Source-link UPDATE bumps sync_sequence so a span change (via
-- `upsertSourceFromPeer` → ON CONFLICT DO UPDATE SET span = ...) doesn't
-- stay invisible to peers whose cursor would skip past the unchanged seq.
CREATE OR REPLACE FUNCTION update_catalog_source_sync_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.span IS DISTINCT FROM OLD.span THEN
    NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_sources', 'sync_sequence'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_source_sync_seq ON catalog_ingredient_sources;
CREATE TRIGGER trg_catalog_source_sync_seq
  BEFORE UPDATE ON catalog_ingredient_sources
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_source_sync_seq();

-- Ref-link UPDATE bumps sync_sequence on soft-delete or revival so peers
-- receive the tombstone as a normal sync event. Without this, the soft-delete
-- path would update `deleted`/`deleted_at` but leave sync_sequence at the
-- original INSERT value — peers past that cursor would never see the change
-- and their "Appears in" panels would stay stale forever.
CREATE OR REPLACE FUNCTION update_catalog_ref_sync_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted IS DISTINCT FROM OLD.deleted
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_refs', 'sync_sequence'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_ref_sync_seq ON catalog_ingredient_refs;
CREATE TRIGGER trg_catalog_ref_sync_seq
  BEFORE UPDATE ON catalog_ingredient_refs
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_ref_sync_seq();

-- Relation UPDATE bumps sync_sequence on soft-delete or revival so peers pick
-- up the tombstone (or the un-delete) on their next pull — same rationale as
-- the ref trigger above.
CREATE OR REPLACE FUNCTION update_catalog_relation_sync_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted IS DISTINCT FROM OLD.deleted
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_relations', 'sync_sequence'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_relation_sync_seq ON catalog_ingredient_relations;
CREATE TRIGGER trg_catalog_relation_sync_seq
  BEFORE UPDATE ON catalog_ingredient_relations
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_relation_sync_seq();

-- Media UPDATE bumps sync_sequence when a soft-delete/revival OR a mutable
-- field (role/caption) changes, so peers receive the edit (or the tombstone)
-- on their next pull. Unlike refs/relations, media rows carry editable
-- metadata, so the change-detector also watches role + caption.
CREATE OR REPLACE FUNCTION update_catalog_media_sync_seq()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted IS DISTINCT FROM OLD.deleted
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.caption IS DISTINCT FROM OLD.caption THEN
    NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_media', 'sync_sequence'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_media_sync_seq ON catalog_ingredient_media;
CREATE TRIGGER trg_catalog_media_sync_seq
  BEFORE UPDATE ON catalog_ingredient_media
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_media_sync_seq();

-- Tag UPDATE bumps sync_sequence + updated_at when a mutable field changes
-- (label/description/color/parent_id) so peers receive the edit on their next
-- pull. Respects an explicit updated_at (the sync apply path preserves the
-- originating timestamp during LWW merges). Mirrors the scrap timestamp trigger.
CREATE OR REPLACE FUNCTION update_catalog_tag_timestamp()
RETURNS TRIGGER AS $$
DECLARE
  content_changed BOOLEAN;
BEGIN
  content_changed := (
    NEW.label IS DISTINCT FROM OLD.label OR
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.color IS DISTINCT FROM OLD.color OR
    NEW.parent_id IS DISTINCT FROM OLD.parent_id OR
    NEW.updated_at IS DISTINCT FROM OLD.updated_at
  );

  IF NOT content_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_tags', 'sync_sequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_tag_updated_at ON catalog_tags;
CREATE TRIGGER trg_catalog_tag_updated_at
  BEFORE UPDATE ON catalog_tags
  FOR EACH ROW
  EXECUTE FUNCTION update_catalog_tag_timestamp();
