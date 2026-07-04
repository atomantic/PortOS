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

-- Versioned DB-migration tracker (#1029). Records which ordered migration files
-- in server/scripts/db-migrations/ have been applied on THIS install. Part of
-- the base schema (mirrored in db.js ensureSchema, parity-locked by
-- db.catalogDdlParity.test.js) so the boot-time runner can always read it.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Memory relationships (bidirectional links)
CREATE TABLE IF NOT EXISTS memory_links (
  source_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

-- Relationship / Tribe graph. People live in Postgres so they can be joined to
-- Brain memories, touchpoint history, and calendar event references.
CREATE TABLE IF NOT EXISTS tribe_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  relationship TEXT DEFAULT '',
  ring VARCHAR(32) NOT NULL DEFAULT 'tribe',
  cadence_days INTEGER NOT NULL DEFAULT 45,
  last_contact_on DATE,
  channel TEXT DEFAULT '',
  energy VARCHAR(32) NOT NULL DEFAULT 'steady',
  tags TEXT[] DEFAULT '{}',
  next_move TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
-- Known emails/handles for a person — the deterministic key that maps a calendar
-- attendee / message counterpart back to this tracked person (#2033).
ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS emails TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_tribe_people_live ON tribe_people (deleted, ring, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tribe_people_tags ON tribe_people USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_tribe_people_emails ON tribe_people USING gin (emails);

CREATE TABLE IF NOT EXISTS tribe_touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
  happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  source VARCHAR(32) NOT NULL DEFAULT 'user',
  calendar_account_id TEXT,
  calendar_event_id TEXT,
  dedupe_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotency key for auto-logged touchpoints (calendar event id / message
-- thread+day); NULL for hand-logged user touchpoints.
ALTER TABLE tribe_touchpoints ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_person ON tribe_touchpoints (person_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_calendar ON tribe_touchpoints (calendar_account_id, calendar_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tribe_touchpoints_dedupe ON tribe_touchpoints (person_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tribe_memory_links (
  person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (person_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_tribe_memory_links_memory ON tribe_memory_links (memory_id);

-- Human activity timeline (#2150) — unified, machine-local event store fed by
-- message/calendar syncs (later: iMessage, Spotify, YouTube, Signal). Metadata +
-- short summary only; full bodies stay in per-source caches. Idempotent via the
-- unique (source, dedupe_key) index + ON CONFLICT DO NOTHING. Machine-local like
-- Tribe (ADR 2026-06-26-tribe-and-universe-runs-local.md) — excluded from peer sync.
CREATE TABLE IF NOT EXISTS human_activity_events (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_activity_dedupe ON human_activity_events (source, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_human_activity_happened ON human_activity_events (happened_at);

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
  -- Scrap chunking (catalog v7): a long paste splits into a parent (chunk_index
  -- 0, parent_scrap_id NULL, raw_text = FULL original) plus N child rows
  -- (chunk_index 1..N, parent_scrap_id → parent, raw_text = chunk slice). A
  -- plain scrap is just a parent with no children. ensureSchema in
  -- server/lib/db.js mirrors these as ADD COLUMN IF NOT EXISTS for existing installs.
  chunk_index INT NOT NULL DEFAULT 0,
  parent_scrap_id TEXT REFERENCES catalog_scraps(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_catalog_scraps_parent ON catalog_scraps (parent_scrap_id);

-- Extracted, structured ingredients. Char/place/object payloads follow the
-- shape sanitized by server/lib/storyBible.js so backfill and fresh ingest
-- produce identical records. Idea/scene/concept payloads are lighter shapes.
CREATE TABLE IF NOT EXISTS catalog_ingredients (
  id TEXT PRIMARY KEY,                         -- 'cat-chr-<uuid>', 'cat-plc-<uuid>', etc.
  -- No DB CHECK on `type`: valid types are gated at the app layer via the
  -- INGREDIENT_TYPES registry (server/lib/catalogTypes.js), enforced by the Zod
  -- enum in catalogValidation.js. Adding a new system (or future user-defined)
  -- type is then a registry entry, NOT a DROP/RE-ADD constraint migration in two
  -- files. VARCHAR(32) leaves headroom for longer type ids.
  type VARCHAR(32) NOT NULL,
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

-- ===========================================================================
-- Creative Director projects (Phase 3, issue #997)
-- ===========================================================================
-- One row per project. The full project record — treatment, scenes, runs[],
-- and the misc back-pointers (collectionId / timelineProjectId / finalVideoId
-- / sourceIssueId) — lives in `data` JSONB. `status` / `created_at` /
-- `updated_at` are mirrored into columns (kept in lockstep with the JSONB on
-- every write) so future queries CAN filter/sort on them without a JSONB
-- expression; `listProjects` sorts by `created_at`. No index on status/
-- updated_at yet — nothing queries them today (the recovery scan filters
-- p.status in JS over the loaded record), and an unused index is just write
-- amplification. Add one alongside the query that needs it.
--
-- Why JSONB and not normalized scene/run tables: no code queries INTO scenes
-- or runs relationally (the orchestrator loads the whole project, mutates a
-- scene or appends a run, writes it back), and scenes carry ad-hoc fields
-- outside the Zod schema (evaluationFrames). Per-PROJECT rows already remove
-- the monolithic-file write contention + O(N²) reserialize the old single
-- creative-director-projects.json caused. Normalizing scenes/runs is deferred
-- to a later phase if a cross-project scene/run query ever materializes.
--
-- As of #1564 CD projects FEDERATE across peers via the per-record peer-sync
-- push pipeline (record kind `creativeDirectorProject`, sync category
-- `creativeDirectorProjects`), so the soft-delete tombstone trio
-- (deleted/deleted_at + LWW updated_at) mirrors the authors table — a delete is a
-- tombstone the merge keeps an out-of-date peer from resurrecting (NOT a hard
-- DELETE). `status` has no DB CHECK; valid values are gated at the app layer via
-- PROJECT_STATUSES (creativeDirectorPresets.js), matching the catalog
-- ingredients convention so a new status needs no constraint migration.
CREATE TABLE IF NOT EXISTS creative_director_projects (
  id TEXT PRIMARY KEY,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so deletes propagate to peers
  deleted_at TIMESTAMPTZ
);
-- Partial index for the live-list filter (deleted = FALSE).
CREATE INDEX IF NOT EXISTS idx_creative_director_projects_live ON creative_director_projects (deleted) WHERE deleted = FALSE;

-- Music Video projects (issue #1760). The director scene board's db-primary
-- record: id/status/created_at/updated_at mirrored as columns, the full project
-- (track link, cached audioAnalysis, scenes[]) in `data` JSONB — same shape as
-- creative_director_projects. The soft-delete tombstone trio is present so
-- peer-sync federation (a follow-up) is additive. Mirrors the music_video_projects
-- block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS music_video_projects (
  id TEXT PRIMARY KEY,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so deletes propagate to peers
  deleted_at TIMESTAMPTZ
);
-- Partial index for the live-list filter (deleted = FALSE).
CREATE INDEX IF NOT EXISTS idx_music_video_projects_live ON music_video_projects (deleted) WHERE deleted = FALSE;

-- Mood boards (issue #911). A dedicated inspiration/mood-board canvas, distinct
-- from raw Media History, for collecting visual + textual references that feed
-- the Create suite. One row per board, the full record (name/description/items[])
-- in `data` JSONB. Each item carries an image (media-key or external URL) or a
-- text note, optional caption, and an optional source backref — kept inline in
-- the board's JSONB rather than a child table because a board is read/written
-- whole (a small bounded item list, no cross-board item queries). `name` mirrors
-- a column for the live-list sort. As of #1564 mood boards FEDERATE across peers
-- via the per-record peer-sync push pipeline (record kind `moodBoard`, sync
-- category `moodBoards`), so the soft-delete tombstone trio (deleted/deleted_at +
-- LWW updated_at) mirrors creative_director_projects — a delete is a tombstone the
-- merge keeps an out-of-date peer from resurrecting (NOT a hard DELETE). Mirrors
-- the mood_boards block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS mood_boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,               -- soft-delete tombstone so deletes propagate to peers
  deleted_at TIMESTAMPTZ
);
-- Backfill the tombstone columns on installs created before #1564 (the CREATE
-- above is a no-op once the table exists), so re-applying this schema to an
-- existing DB stays idempotent and the partial index below can reference `deleted`.
ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- updated_at DESC is the board-list "recently touched" sort.
CREATE INDEX IF NOT EXISTS idx_mood_boards_updated ON mood_boards (updated_at DESC);
-- Partial index for the live-list filter (deleted = FALSE).
CREATE INDEX IF NOT EXISTS idx_mood_boards_live ON mood_boards (deleted) WHERE deleted = FALSE;

-- Media asset index (Phase 3.2, issue #1000). One row per generated image or
-- video. The bytes stay on disk (data/images, data/videos) and the image
-- sidecars + data/video-history.json remain authoritative — this table is a
-- DERIVED, queryable index, reconciled from disk at boot and kept warm by a
-- generation-completed hook. `media_key` is the shared `<kind>:<ref>` key
-- (mediaItemKey.js); `kind`/`ref` mirror into columns for queries while the
-- full metadata record lives in `data` JSONB. created_at is the asset's own
-- timestamp; indexed_at is when this index row was written. No
-- sync_sequence/tombstone: the index is local-only (rebuilt from disk), not
-- federated — a row vanishes when its file does (prune on reconcile). Mirrors
-- the media_assets block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS media_assets (
  media_key TEXT PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  ref TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  indexed_at TIMESTAMPTZ DEFAULT NOW()
);
-- created_at DESC is the gallery/history sort order; kind narrows
-- images-vs-videos. A composite (kind, created_at DESC) serves both.
CREATE INDEX IF NOT EXISTS idx_media_assets_kind_created ON media_assets (kind, created_at DESC);

-- Catalog user-defined types (Phase 4 lead-in, issue #1001). One row per
-- user-defined ingredient type — the registry that defines catalog row
-- semantics, moved out of data/settings.json (`catalogUserTypes`) so type
-- evolution versions/syncs alongside the catalog data it governs. `id` is the
-- type discriminator (the `type` column on catalog_ingredients + the
-- `cat-<prefix>-<uuid>` mint seed); the full definition lives in `data` JSONB.
-- updated_at / deleted_at mirror the federation LWW clock + tombstone (a
-- soft-deleted type is KEPT as a tombstone row so the deletion federates —
-- setUserCatalogTypes filters tombstones out of the active registry). ≤64 rows,
-- read whole on every warm/sync, so no secondary index. Mirrors the
-- catalog_user_types block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS catalog_user_types (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Universe Builder records (Phase 3 Create migration, issue #1014). One row per
-- universe, the full sanitized record (canon bibles, categories, compositeSheets,
-- locks, influences) in `data` JSONB, moved out of data/universes/{id}/index.json
-- (collectionStore). Only the fields the service/federation query, join, or sort
-- on are mirrored into columns: `name` (rename-cascade + delete-guard + list
-- sort), `schema_version` (the RECORD-shape version sanitizeTemplate stamps — a
-- column so a future migration can find unmigrated rows without parsing JSONB),
-- `ephemeral` (the snapshot loop filters local-only records), and the
-- LWW/tombstone trio (updated_at/deleted/deleted_at). NO sync_sequence: universes
-- federate via the EXISTING dataSync snapshot/push model (LWW on the body's
-- updatedAt), NOT catalog-style pull cursors — the storage swap is invisible to
-- peers (no schema-version bump). The mirror columns are populated FROM the
-- record body, not a DB trigger. Mirrors the universes block in db.js
-- ensureSchema().
CREATE TABLE IF NOT EXISTS universes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 4,
  ephemeral BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
-- Partial index on the live set — the common list/scan path is "non-deleted
-- universes". updated_at supports LWW-staleness scans.
CREATE INDEX IF NOT EXISTS idx_universes_live ON universes (deleted) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_universes_updated ON universes (updated_at);

-- Universe render-history log (issue #1014). The type-level `config.runs[]` array
-- collectionStore kept in data/universes/index.json (capped 200, NEVER federated
-- — per-peer local) becomes its own table. `universe_id` is a soft ref (no FK):
-- the cascade-clean on universe delete is handled in the service exactly as the
-- file backend did, and a soft ref keeps the table independent of universe-row
-- insert ordering during the one-time import. `data` holds
-- jobIds[]/promptCount/collectionId. Mirrors db.js ensureSchema().
CREATE TABLE IF NOT EXISTS universe_runs (
  id TEXT PRIMARY KEY,
  universe_id TEXT NOT NULL,
  collection_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_universe_runs_universe ON universe_runs (universe_id, created_at DESC);

-- Author personas. One row per reusable author/byline persona, the full
-- sanitized record (name, writingStyle, bio, physicalDescription, headshotStyle,
-- headshotImageUrl) in `data` JSONB. `name` mirrors a column for the live-list
-- sort; the LWW/tombstone trio (updated_at/deleted/deleted_at) is populated FROM
-- the record body. Authors are db-primary AND federated via the per-record
-- peer-sync push pipeline (record kind `author`, sync category `authors`); a
-- federated series also keeps its denormalized `author` byline so a peer that
-- hasn't synced the persona still renders the cover correctly. Mirrors the
-- authors block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
-- The common path is "live authors sorted by name".
CREATE INDEX IF NOT EXISTS idx_authors_live ON authors (deleted) WHERE deleted = FALSE;

-- Music artists (the Music studio's persona store — analogue of authors). One
-- row per artist, the full sanitized record (name, genre, bio, musicalStyle,
-- physicalDescription, portraitStyle, portraitImageUrl) in `data` JSONB. `name`
-- mirrors a column for the live-list sort; the LWW/tombstone trio is populated
-- FROM the record body. Artists are db-primary and federation-ready (LWW merge
-- mirrors authors), but the artist record kind is not yet registered in peerSync
-- — local-only for now (see issue #1502). Mirrors the artists block in db.js.
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
-- The common path is "live artists sorted by name".
CREATE INDEX IF NOT EXISTS idx_artists_live ON artists (deleted) WHERE deleted = FALSE;

-- Music albums (the Music studio). One row per album, the full sanitized record
-- (title, artistId + denormalized artist, description, genre, releaseYear,
-- coverImageUrl, ordered trackIds) in `data` JSONB. `title` mirrors a column for
-- the live-list sort. db-primary + federation-ready (LWW merge mirrors artists),
-- not yet registered in peerSync — local-only for now (see issue #1502). Mirrors
-- the albums block in db.js.
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_albums_live ON albums (deleted) WHERE deleted = FALSE;

-- Music tracks (the Music studio). One row per track, the full sanitized record
-- (title, albumId/artistId FKs + denormalized artist, lyrics, prompt, engine/
-- modelId/durationSec gen metadata, audioFilename pointing into the shared music
-- library at data/music/) in `data` JSONB. `title` mirrors a column for queries.
-- db-primary + federation-ready, not yet registered in peerSync — local-only for
-- now (see issue #1502). Mirrors the tracks block in db.js.
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tracks_live ON tracks (deleted) WHERE deleted = FALSE;

-- Pipeline series (Phase 3 Create migration, issue #1015). One row per series,
-- the full sanitized record (arc/seasons/locks/covers/style) in `data` JSONB,
-- moved out of data/pipeline-series/{id}/index.json (collectionStore). Only the
-- fields the service/federation query, join, or sort on are mirrored into
-- columns: `name` (rename-cascade + list sort), `universe_id` (the hot
-- relationship — delete-guard + "series in this universe" lists; soft ref, no
-- FK — a series can sync before its universe arrives), and the promote
-- back-link `writers_room_work_id`. `ephemeral` + the LWW/tombstone trio
-- (updated_at/deleted/deleted_at) populated FROM the record body, not a DB
-- trigger. NO sync_sequence: pipeline records federate via the EXISTING
-- dataSync snapshot/push model — the storage swap is invisible to peers (no
-- schema-version bump). Mirrors the pipeline_series block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS pipeline_series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  universe_id TEXT,
  writers_room_work_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_series_universe ON pipeline_series (universe_id) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_series_wr_work ON pipeline_series (writers_room_work_id);
CREATE INDEX IF NOT EXISTS idx_series_updated ON pipeline_series (updated_at);

-- Pipeline issues (issue #1015). One row per issue; the 8-stage `stages` map
-- (text/visual/audio, runHistory, canonExtraction, covers) + lastRunId pointers
-- stay entirely in `data` JSONB (document-shaped, sanitizer-owned). `series_id`
-- (parent, soft ref), `season_id` (arc grouping), and `number`
-- (renumber-recomputed ordinal) are promoted — the renumber pass reads all
-- issues of a series ordered by number, the single most common cross-record
-- pipeline query, served directly by idx_issues_series (series_id, number).
-- `status` promoted for "issues needing review" dashboards. `ephemeral` +
-- LWW/tombstone trio mirror the body. NO sync_sequence (see pipeline_series).
-- Mirrors the pipeline_issues block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS pipeline_issues (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  season_id TEXT,
  number INTEGER,
  status VARCHAR(32),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_issues_series ON pipeline_issues (series_id, number) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_issues_season ON pipeline_issues (season_id) WHERE season_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_updated ON pipeline_issues (updated_at);

-- Story Builder sessions (issue #1016). One row per session; the conductor
-- bookkeeping (`steps` lock/integrity map, `syncedHashes` baseline,
-- `currentStep`, `llm` picker choice) stays entirely in `data` JSONB. The two
-- FKs `universe_id` / `series_id` are promoted for "sessions linked to this
-- record" lookups. `sync` is promoted because Story Builder is the one store
-- whose federation is OPT-IN — the snapshot loop filters WHERE sync = TRUE to
-- decide what to even consider pushing, so promoting it avoids deserializing
-- every session's `data` per snapshot tick. `ephemeral` + the LWW/tombstone
-- trio mirror the body. NO sync_sequence (sessions ride the existing dataSync
-- snapshot/LWW model, not the per-record push pipeline).
-- Mirrors the story_builder_sessions block in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS story_builder_sessions (
  id TEXT PRIMARY KEY,
  universe_id TEXT,
  series_id TEXT,
  sync BOOLEAN DEFAULT FALSE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ephemeral BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stb_universe ON story_builder_sessions (universe_id);
CREATE INDEX IF NOT EXISTS idx_stb_series ON story_builder_sessions (series_id);
CREATE INDEX IF NOT EXISTS idx_stb_updated ON story_builder_sessions (updated_at);

-- Writers Room (Phase 3 Create migration, issue #1017). FOUR tables replace the
-- bespoke file layout (folders.json, exercises.json, per-work manifest.json).
-- Writers Room is NOT federated (no dataSync category, no schema-version gate),
-- so unlike the universe/pipeline/story-builder tables these carry NO
-- `ephemeral`/`sync`/sync_sequence columns. The only thing that stays on disk is
-- the draft prose body (drafts/<draftId>.md, file-primary); its metadata is the
-- draft_versions row.
-- Mirrors the writers_room_* blocks in db.js ensureSchema().
CREATE TABLE IF NOT EXISTS writers_room_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wr_folders_parent ON writers_room_folders (parent_id, sort_order);

CREATE TABLE IF NOT EXISTS writers_room_works (
  id TEXT PRIMARY KEY,
  folder_id TEXT,
  title TEXT NOT NULL,
  kind VARCHAR(32),
  status VARCHAR(32),
  active_draft_version_id TEXT,
  pipeline_series_id TEXT,
  pipeline_issue_id TEXT,
  cd_project_id TEXT,
  media_collection_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wr_works_folder ON writers_room_works (folder_id) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_wr_works_series ON writers_room_works (pipeline_series_id) WHERE pipeline_series_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS writers_room_draft_versions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  label TEXT,
  content_file TEXT NOT NULL,
  content_hash TEXT,
  word_count INTEGER DEFAULT 0,
  segment_index JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_from_version_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wr_drafts_work ON writers_room_draft_versions (work_id, created_at);

CREATE TABLE IF NOT EXISTS writers_room_exercises (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  status VARCHAR(16),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wr_exercises_work ON writers_room_exercises (work_id, started_at DESC);

-- LoRA training runs (character LoRA training, /api/lora-training). One row
-- per run: id/status/character_id mirrored as columns for filtering, the
-- full record in `data` JSONB. Machine-local — no sync cursor/tombstones
-- (training artifacts live on this machine's disk under data/training-runs/).
CREATE TABLE IF NOT EXISTS lora_training_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  character_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lora_training_runs_status ON lora_training_runs (status);
CREATE INDEX IF NOT EXISTS idx_lora_training_runs_character ON lora_training_runs (character_id);

-- Deletion audit log (incident #1248-follow-up). Append-only forensic trail of
-- every tombstone / un-tombstone / hard-delete of user-authored records, written
-- by a DB trigger so it captures deletions from ANY source (app, a test suite's
-- raw DELETE, a manual psql session). row_snapshot keeps the OLD row JSON so a
-- wrongful delete is recoverable from the log alone. Local-only (not federated).
-- Mirrors the record_audit block in server/lib/db.js (parity-locked by
-- db.catalogDdlParity.test.js).
CREATE TABLE IF NOT EXISTS record_audit (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT,
  record_name TEXT,
  action VARCHAR(16) NOT NULL,
  actor TEXT,
  source_query TEXT,
  application_name TEXT,
  backend_pid INTEGER,
  row_snapshot JSONB,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_record_audit_record ON record_audit (table_name, record_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_audit_occurred ON record_audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_audit_action ON record_audit (action, occurred_at DESC);

-- Generic audit trigger function — reads id/name/title/deleted/deleted_at out of
-- to_jsonb(OLD/NEW) so it needs no per-table column knowledge. A row is "deleted"
-- when `deleted` is true OR `deleted_at` is non-null. See server/lib/db.js for
-- the authoritative copy + commentary.
CREATE OR REPLACE FUNCTION record_audit_log()
RETURNS TRIGGER AS $$
DECLARE
  oldj JSONB := to_jsonb(OLD);
  newj JSONB;
  was_deleted BOOLEAN;
  now_deleted BOOLEAN;
  v_action TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_action := 'hard_delete';
    INSERT INTO record_audit
      (table_name, record_id, record_name, action, actor, source_query, application_name, backend_pid, row_snapshot)
    VALUES
      (TG_TABLE_NAME, oldj->>'id', COALESCE(oldj->>'name', oldj->>'title'), v_action,
       current_setting('portos.actor', true), current_query(),
       current_setting('application_name', true), pg_backend_pid(), oldj);
    RETURN OLD;
  END IF;

  newj := to_jsonb(NEW);
  was_deleted := COALESCE((oldj->>'deleted')::boolean, oldj->>'deleted_at' IS NOT NULL, false);
  now_deleted := COALESCE((newj->>'deleted')::boolean, newj->>'deleted_at' IS NOT NULL, false);
  IF now_deleted AND NOT was_deleted THEN
    v_action := 'tombstone';
  ELSIF was_deleted AND NOT now_deleted THEN
    v_action := 'untombstone';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO record_audit
    (table_name, record_id, record_name, action, actor, source_query, application_name, backend_pid, row_snapshot)
  VALUES
    (TG_TABLE_NAME, newj->>'id', COALESCE(newj->>'name', newj->>'title'), v_action,
     current_setting('portos.actor', true), current_query(),
     current_setting('application_name', true), pg_backend_pid(), newj);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Audit trigger on every user-authored-content table. AUDITED_RECORD_TABLES —
-- keep in sync with the auditedTables list in server/lib/db.js.
DROP TRIGGER IF EXISTS trg_universes_audit ON universes;
CREATE TRIGGER trg_universes_audit AFTER UPDATE OR DELETE ON universes FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_universe_runs_audit ON universe_runs;
CREATE TRIGGER trg_universe_runs_audit AFTER UPDATE OR DELETE ON universe_runs FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_pipeline_series_audit ON pipeline_series;
CREATE TRIGGER trg_pipeline_series_audit AFTER UPDATE OR DELETE ON pipeline_series FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_pipeline_issues_audit ON pipeline_issues;
CREATE TRIGGER trg_pipeline_issues_audit AFTER UPDATE OR DELETE ON pipeline_issues FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_story_builder_sessions_audit ON story_builder_sessions;
CREATE TRIGGER trg_story_builder_sessions_audit AFTER UPDATE OR DELETE ON story_builder_sessions FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_writers_room_works_audit ON writers_room_works;
CREATE TRIGGER trg_writers_room_works_audit AFTER UPDATE OR DELETE ON writers_room_works FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_writers_room_folders_audit ON writers_room_folders;
CREATE TRIGGER trg_writers_room_folders_audit AFTER UPDATE OR DELETE ON writers_room_folders FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_writers_room_draft_versions_audit ON writers_room_draft_versions;
CREATE TRIGGER trg_writers_room_draft_versions_audit AFTER UPDATE OR DELETE ON writers_room_draft_versions FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_catalog_ingredients_audit ON catalog_ingredients;
CREATE TRIGGER trg_catalog_ingredients_audit AFTER UPDATE OR DELETE ON catalog_ingredients FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_catalog_scraps_audit ON catalog_scraps;
CREATE TRIGGER trg_catalog_scraps_audit AFTER UPDATE OR DELETE ON catalog_scraps FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_catalog_user_types_audit ON catalog_user_types;
CREATE TRIGGER trg_catalog_user_types_audit AFTER UPDATE OR DELETE ON catalog_user_types FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_creative_director_projects_audit ON creative_director_projects;
CREATE TRIGGER trg_creative_director_projects_audit AFTER UPDATE OR DELETE ON creative_director_projects FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_mood_boards_audit ON mood_boards;
CREATE TRIGGER trg_mood_boards_audit AFTER UPDATE OR DELETE ON mood_boards FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_lora_training_runs_audit ON lora_training_runs;
CREATE TRIGGER trg_lora_training_runs_audit AFTER UPDATE OR DELETE ON lora_training_runs FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_authors_audit ON authors;
CREATE TRIGGER trg_authors_audit AFTER UPDATE OR DELETE ON authors FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_artists_audit ON artists;
CREATE TRIGGER trg_artists_audit AFTER UPDATE OR DELETE ON artists FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_albums_audit ON albums;
CREATE TRIGGER trg_albums_audit AFTER UPDATE OR DELETE ON albums FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_tracks_audit ON tracks;
CREATE TRIGGER trg_tracks_audit AFTER UPDATE OR DELETE ON tracks FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_tribe_people_audit ON tribe_people;
CREATE TRIGGER trg_tribe_people_audit AFTER UPDATE OR DELETE ON tribe_people FOR EACH ROW EXECUTE FUNCTION record_audit_log();
DROP TRIGGER IF EXISTS trg_tribe_touchpoints_audit ON tribe_touchpoints;
CREATE TRIGGER trg_tribe_touchpoints_audit AFTER UPDATE OR DELETE ON tribe_touchpoints FOR EACH ROW EXECUTE FUNCTION record_audit_log();
