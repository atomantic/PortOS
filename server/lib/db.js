/**
 * Database Connection Pool
 *
 * PostgreSQL connection management for the memory system.
 * Uses pg (node-postgres) with a connection pool for efficient query execution.
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.PGPASSWORD) {
  console.warn('⚠️ PGPASSWORD not set — using default. Set PGPASSWORD env var for production.');
}

// Connection config from environment or defaults
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'portos',
  user: process.env.PGUSER || 'portos',
  password: process.env.PGPASSWORD || 'portos',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error(`🗄️ Database pool error: ${err.message}`);
});

/**
 * Execute a query against the connection pool.
 * @param {string} text - SQL query text with $1, $2, etc. placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a function inside a database transaction.
 * Auto-commits on success, rolls back on error.
 * @param {function(pg.PoolClient): Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  await client.query('BEGIN');
  let result;
  try {
    result = await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return result;
}

/**
 * Check if the database is reachable and the schema is initialized.
 * @returns {Promise<{connected: boolean, hasSchema: boolean, error?: string}>}
 */
export async function checkHealth() {
  try {
    const result = await pool.query(`
      SELECT
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories') AS has_memories,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memory_links') AS has_links,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'sync_sequence') AS has_sync,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'catalog_ingredients') AS has_catalog,
        EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'catalog_scraps') AS has_catalog_scraps
    `);
    const { has_memories, has_links, has_sync, has_catalog, has_catalog_scraps } = result.rows?.[0] ?? {};
    return {
      connected: true,
      hasSchema: has_memories && has_links && has_sync,
      hasCatalogSchema: has_catalog && has_catalog_scraps,
    };
  } catch (err) {
    console.error(`🗄️ Database health check failed: ${err.message}`);
    return { connected: false, hasSchema: false, hasCatalogSchema: false, error: err.message };
  }
}

// In-flight dedup for ensureSchema(). At boot, two independent fire-and-forget
// callers can race: the Creative Director recovery scan (which lazily selects
// the PG backend and calls ensureSchema) and the boot DB gate. Running the
// idempotent DDL list concurrently can intermittently error or deadlock on
// Postgres system catalogs (concurrent CREATE TABLE/INDEX IF NOT EXISTS contend
// on pg_type / pg_class). Sharing one in-flight promise serializes them; it's
// cleared on settle so a deliberate later call (the gate runs it twice) still
// re-applies (cheap — ~30 no-op parses on an up-to-date DB).
let ensureSchemaInFlight = null;

/**
 * Apply idempotent schema upgrades to an existing database.
 * Each statement uses IF NOT EXISTS so it's safe to run on every startup.
 * Add new ALTER TABLE statements here when the schema evolves.
 *
 * Concurrent calls share a single in-flight execution (see ensureSchemaInFlight).
 */
export async function ensureSchema() {
  if (ensureSchemaInFlight) return ensureSchemaInFlight;
  ensureSchemaInFlight = ensureSchemaImpl().finally(() => { ensureSchemaInFlight = null; });
  return ensureSchemaInFlight;
}

async function ensureSchemaImpl() {
  const upgrades = [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS sync_sequence BIGSERIAL`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_instance_id VARCHAR(36)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_origin_instance ON memories (origin_instance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_sync_sequence ON memories (sync_sequence)`,
  ];
  for (const sql of upgrades) {
    await pool.query(sql);
  }

  // Catalog block: every statement below is idempotent (CREATE IF NOT EXISTS
  // / CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS + CREATE TRIGGER),
  // so we run the whole list on every boot rather than gating on table
  // presence. A previous probe that early-returned on "all four tables exist"
  // would skip the indexes / functions / triggers if the prior boot crashed
  // between the table CREATEs and the artifact CREATEs — leaving the schema
  // marked ready while update triggers and HNSW indexes were never installed.
  // Cost on a fully-applied install is ~30 Postgres no-op parses (<10ms).

  const catalogDDL = [
    `CREATE TABLE IF NOT EXISTS catalog_scraps (
      id TEXT PRIMARY KEY,
      title TEXT,
      raw_text TEXT NOT NULL,
      source_kind VARCHAR(32) DEFAULT 'paste',
      metadata JSONB DEFAULT '{}'::jsonb,
      embedding vector(768),
      embedding_model VARCHAR(100),
      origin_instance_id VARCHAR(36),
      chunk_index INT NOT NULL DEFAULT 0,
      parent_scrap_id TEXT REFERENCES catalog_scraps(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      sync_sequence BIGSERIAL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_embedding
       ON catalog_scraps USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_fts
       ON catalog_scraps USING gin (
         to_tsvector('english', coalesce(title, '') || ' ' || coalesce(raw_text, ''))
       )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_sync_seq ON catalog_scraps (sync_sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_created_at ON catalog_scraps (created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_origin_instance ON catalog_scraps (origin_instance_id)`,
    // Scrap chunking (catalog v7): a long paste is split into a parent row
    // (chunk_index 0, raw_text = the FULL original text so the FTS index stays
    // populated) plus N child rows (parent_scrap_id → parent, chunk_index 1..N,
    // raw_text = the chunk slice). The extractor processes each child and unions
    // results. The columns are declared inline in the CREATE above (fresh
    // installs) AND re-added idempotently here for EXISTING installs (CREATE IF
    // NOT EXISTS won't add columns to a pre-existing table). Existing rows
    // default to chunk_index 0 / parent_scrap_id NULL — a plain non-chunked
    // scrap, unchanged behavior. We do NOT retro-chunk existing rows.
    `ALTER TABLE catalog_scraps ADD COLUMN IF NOT EXISTS chunk_index INT NOT NULL DEFAULT 0`,
    `ALTER TABLE catalog_scraps ADD COLUMN IF NOT EXISTS parent_scrap_id TEXT REFERENCES catalog_scraps(id) ON DELETE CASCADE`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_scraps_parent ON catalog_scraps (parent_scrap_id)`,

    `CREATE TABLE IF NOT EXISTS catalog_ingredients (
      id TEXT PRIMARY KEY,
      -- No DB CHECK on \`type\`: valid types are gated at the app layer via the
      -- INGREDIENT_TYPES registry (catalogTypes.js / catalogValidation.js Zod
      -- enum), so a new system or user-defined type needs no constraint migration.
      -- VARCHAR(32) leaves headroom for longer type ids. The DROP CONSTRAINT +
      -- widen for existing installs runs in the idempotent ALTER block below.
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
    )`,
    // Relax the legacy `type` CHECK on existing installs: types are now gated at
    // the app layer (INGREDIENT_TYPES registry + Zod enum), so a new system or
    // user-defined type doesn't need a DROP/RE-ADD constraint migration. Postgres
    // auto-named the inline CHECK `catalog_ingredients_type_check`. Both statements
    // are idempotent — DROP IF EXISTS no-ops once gone; the column-type widen
    // no-ops when already VARCHAR(32).
    `ALTER TABLE catalog_ingredients DROP CONSTRAINT IF EXISTS catalog_ingredients_type_check`,
    `ALTER TABLE catalog_ingredients ALTER COLUMN type TYPE VARCHAR(32)`,
    // Postgres can't ALTER the expression of a STORED generated column, so when
    // the v2 expansion needs to land we DROP and re-ADD `search_tsv`. The
    // conditional below (executed after the table CREATE, before the
    // ADD-only fallback) inspects pg_attrdef and rewrites the column ONLY
    // when the current generation expression is missing a v2-only field
    // (`physicalDescription`). That keeps boot O(1) on already-v2 installs —
    // an unconditional DROP+ADD would AccessExclusive-lock the table, rewrite
    // every row, and rebuild the GIN index on every server start.
    // Fresh installs (no column yet) fall through to the ADD IF NOT EXISTS
    // below and skip the DROP entirely.
    `DO $$
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
       END$$`,
    `ALTER TABLE catalog_ingredients ADD COLUMN IF NOT EXISTS search_tsv tsvector
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
       ) STORED`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_embedding
       ON catalog_ingredients USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_fts ON catalog_ingredients USING gin (search_tsv)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_type ON catalog_ingredients (type)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_tags ON catalog_ingredients USING gin (tags)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_sync_seq ON catalog_ingredients (sync_sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_created_at ON catalog_ingredients (created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_origin_instance ON catalog_ingredients (origin_instance_id)`,

    `CREATE TABLE IF NOT EXISTS catalog_ingredient_sources (
      ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      scrap_id TEXT NOT NULL REFERENCES catalog_scraps(id) ON DELETE CASCADE,
      span JSONB,
      extracted_at TIMESTAMPTZ DEFAULT NOW(),
      sync_sequence BIGSERIAL,
      PRIMARY KEY (ingredient_id, scrap_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_sources_scrap ON catalog_ingredient_sources (scrap_id)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_sources_sync_seq ON catalog_ingredient_sources (sync_sequence)`,

    `CREATE TABLE IF NOT EXISTS catalog_ingredient_refs (
      ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      ref_kind VARCHAR(32) NOT NULL,
      ref_id TEXT NOT NULL,
      role VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      sync_sequence BIGSERIAL,
      PRIMARY KEY (ingredient_id, ref_kind, ref_id, role)
    )`,
    // Idempotent upgrade path for existing installs predating the soft-delete
    // columns. Without these, an old install boots the new code and silently
    // hard-DELETEs on unlink (no tombstone, no sync_sequence bump) — peers
    // never learn the ref was removed.
    `ALTER TABLE catalog_ingredient_refs ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE catalog_ingredient_refs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_refs_target ON catalog_ingredient_refs (ref_kind, ref_id)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_refs_sync_seq ON catalog_ingredient_refs (sync_sequence)`,

    // Ingredient↔ingredient edges (the catalog graph seam). `kind` is an
    // app-layer enum (RELATION_KINDS in catalogTypes.js), not a DB CHECK.
    // Both ids CASCADE on ingredient hard-delete; soft-delete columns from day
    // one so unlinks tombstone + propagate to peers.
    `CREATE TABLE IF NOT EXISTS catalog_ingredient_relations (
      from_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      kind VARCHAR(32) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      sync_sequence BIGSERIAL,
      PRIMARY KEY (from_id, to_id, kind)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_relations_to ON catalog_ingredient_relations (to_id)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_relations_sync_seq ON catalog_ingredient_relations (sync_sequence)`,

    // First-class canonical tag table. Additive index over the freeform
    // `catalog_ingredients.tags TEXT[]` column (which stays as-is). `id` is
    // deterministic (`cat-tag-<canonical-key>`) so the same tag has the same id
    // on every install; `parent_id` self-FK (ON DELETE SET NULL) enables tag
    // hierarchies without cascading a subtree away.
    `CREATE TABLE IF NOT EXISTS catalog_tags (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      color VARCHAR(32),
      parent_id TEXT REFERENCES catalog_tags(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      sync_sequence BIGSERIAL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_tags_label ON catalog_tags (label)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_tags_parent ON catalog_tags (parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_tags_sync_seq ON catalog_tags (sync_sequence)`,

    // Append-only revision history for catalog_ingredients (local audit, not
    // federated). Written by catalogDB.updateIngredient on every content change
    // + a seed row on create; pruned to the last CATALOG_REVISION_RETENTION per
    // ingredient at the app layer. No sync_sequence — revisions stay local; the
    // synced ingredient row already LWW-merges the latest state across peers.
    // Mirrors the catalog_ingredient_revisions block in init-db.sql (parity is
    // asserted by db.catalogDdlParity.test.js).
    `CREATE TABLE IF NOT EXISTS catalog_ingredient_revisions (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      tags TEXT[] DEFAULT '{}',
      source VARCHAR(16) NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'extract', 'refine', 'sync')),
      actor VARCHAR(120),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_revisions_ingredient
       ON catalog_ingredient_revisions (ingredient_id, created_at DESC)`,

    // Typed media attachments — `media_key` REFERENCES the media library
    // (data/images + history.jsonl sidecar) by key; the bytes are never copied
    // here, so federation ships the key and the receiver matches its own
    // library (missing → metadata-missing integrity surface). `kind` is an
    // app-layer enum (MEDIA_KINDS in catalogTypes.js), not a DB CHECK. Soft-
    // delete from day one so detaches tombstone + propagate. Mirrors the
    // catalog_ingredient_media block in init-db.sql (parity is asserted by
    // db.catalogDdlParity.test.js).
    `CREATE TABLE IF NOT EXISTS catalog_ingredient_media (
      ingredient_id TEXT NOT NULL REFERENCES catalog_ingredients(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      kind VARCHAR(32) NOT NULL,
      role VARCHAR(64),
      caption TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      sync_sequence BIGSERIAL,
      PRIMARY KEY (ingredient_id, media_key, kind)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_ingredient ON catalog_ingredient_media (ingredient_id)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_key ON catalog_ingredient_media (media_key)`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_ing_media_sync_seq ON catalog_ingredient_media (sync_sequence)`,

    `CREATE OR REPLACE FUNCTION update_catalog_ingredient_timestamp()
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
       IF NOT content_changed THEN RETURN NEW; END IF;
       IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
         NEW.updated_at := NOW();
       END IF;
       NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredients', 'sync_sequence'));
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_ingredient_updated_at ON catalog_ingredients`,
    `CREATE TRIGGER trg_catalog_ingredient_updated_at
       BEFORE UPDATE ON catalog_ingredients
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_ingredient_timestamp()`,

    `CREATE OR REPLACE FUNCTION update_catalog_scrap_timestamp()
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
       IF NOT content_changed THEN RETURN NEW; END IF;
       IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
         NEW.updated_at := NOW();
       END IF;
       NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_scraps', 'sync_sequence'));
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_scrap_updated_at ON catalog_scraps`,
    `CREATE TRIGGER trg_catalog_scrap_updated_at
       BEFORE UPDATE ON catalog_scraps
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_scrap_timestamp()`,

    // Source-link UPDATE bumps sync_sequence so a span change (via
    // `upsertSourceFromPeer` → ON CONFLICT DO UPDATE SET span = ...) doesn't
    // stay invisible to peers (whose cursor would skip past the unchanged seq).
    `CREATE OR REPLACE FUNCTION update_catalog_source_sync_seq()
     RETURNS TRIGGER AS $$
     BEGIN
       IF NEW.span IS DISTINCT FROM OLD.span THEN
         NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_sources', 'sync_sequence'));
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_source_sync_seq ON catalog_ingredient_sources`,
    `CREATE TRIGGER trg_catalog_source_sync_seq
       BEFORE UPDATE ON catalog_ingredient_sources
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_source_sync_seq()`,

    // Ref-link UPDATE bumps sync_sequence so a soft-delete or revival of a
    // ref row ships as a normal sync event. Without this, the soft-delete
    // path would update `deleted`/`deleted_at` but leave sync_sequence at
    // the original INSERT value — peers past that cursor would never see
    // the tombstone and their "Appears in" panels would stay stale.
    `CREATE OR REPLACE FUNCTION update_catalog_ref_sync_seq()
     RETURNS TRIGGER AS $$
     BEGIN
       IF NEW.deleted IS DISTINCT FROM OLD.deleted
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
         NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_refs', 'sync_sequence'));
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_ref_sync_seq ON catalog_ingredient_refs`,
    `CREATE TRIGGER trg_catalog_ref_sync_seq
       BEFORE UPDATE ON catalog_ingredient_refs
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_ref_sync_seq()`,

    // Relation UPDATE bumps sync_sequence on soft-delete / revival so a peer
    // sees the tombstone (or un-delete) on its next pull — mirrors the ref
    // trigger above.
    `CREATE OR REPLACE FUNCTION update_catalog_relation_sync_seq()
     RETURNS TRIGGER AS $$
     BEGIN
       IF NEW.deleted IS DISTINCT FROM OLD.deleted
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
         NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_ingredient_relations', 'sync_sequence'));
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_relation_sync_seq ON catalog_ingredient_relations`,
    `CREATE TRIGGER trg_catalog_relation_sync_seq
       BEFORE UPDATE ON catalog_ingredient_relations
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_relation_sync_seq()`,

    // Media UPDATE bumps sync_sequence on soft-delete/revival OR a mutable
    // field (role/caption) change so a peer sees the edit/tombstone next pull.
    // Mirrors the relation trigger but also watches the editable metadata.
    `CREATE OR REPLACE FUNCTION update_catalog_media_sync_seq()
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
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_media_sync_seq ON catalog_ingredient_media`,
    `CREATE TRIGGER trg_catalog_media_sync_seq
       BEFORE UPDATE ON catalog_ingredient_media
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_media_sync_seq()`,

    // Tag UPDATE bumps sync_sequence + updated_at on a mutable-field change
    // (label/description/color/parent_id) so a peer sees the edit on its next
    // pull. Mirrors the scrap timestamp trigger.
    `CREATE OR REPLACE FUNCTION update_catalog_tag_timestamp()
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
       IF NOT content_changed THEN RETURN NEW; END IF;
       IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
         NEW.updated_at := NOW();
       END IF;
       NEW.sync_sequence := nextval(pg_get_serial_sequence('catalog_tags', 'sync_sequence'));
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_catalog_tag_updated_at ON catalog_tags`,
    `CREATE TRIGGER trg_catalog_tag_updated_at
       BEFORE UPDATE ON catalog_tags
       FOR EACH ROW
       EXECUTE FUNCTION update_catalog_tag_timestamp()`,

    // Creative Director projects (Phase 3, issue #997). One row per project;
    // the full record lives in `data` JSONB, with status/created_at/updated_at
    // mirrored into columns (kept in lockstep on every write) for future
    // queries. `listProjects` sorts by created_at; nothing filters status yet
    // (the recovery scan filters in JS), so no status/updated_at index — an
    // unused index is just write amplification. CD is local-only (not
    // federated) so no sync_sequence/tombstone. `status` is app-layer gated
    // (PROJECT_STATUSES), no DB CHECK. Mirrors the creative_director_projects
    // block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS creative_director_projects (
      id TEXT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Media asset index (Phase 3.2, issue #1000). One row per generated image
    // or video; the bytes stay on disk (data/images, data/videos) and the
    // sidecar/.json history files remain authoritative — this table is a
    // DERIVED, queryable index, reconciled from disk at boot + kept warm by a
    // generation-completed hook. `media_key` is the shared `<kind>:<ref>`
    // vocabulary (mediaItemKey.js); `kind`/`ref` are mirrored into columns for
    // queries, the full metadata record lives in `data` JSONB. created_at is
    // the asset's own timestamp; indexed_at is when this index row was written.
    // No sync_sequence/tombstone: the index is local-only (rebuilt from disk),
    // not federated — a row vanishes when its file does (prune on reconcile).
    // Mirrors the media_assets block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS media_assets (
      media_key TEXT PRIMARY KEY,
      kind VARCHAR(16) NOT NULL,
      ref TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      indexed_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // created_at DESC is the gallery/history sort order; kind narrows
    // images-vs-videos. A composite (kind, created_at DESC) serves both.
    `CREATE INDEX IF NOT EXISTS idx_media_assets_kind_created ON media_assets (kind, created_at DESC)`,

    // Catalog user-defined types (Phase 4 lead-in, issue #1001). One row per
    // user-defined ingredient type — the registry that defines catalog row
    // semantics, moved out of data/settings.json (`catalogUserTypes`) so type
    // evolution versions/syncs alongside the catalog data it governs. `id` is
    // the type discriminator (the `type` column on catalog_ingredients + the
    // `cat-<prefix>-<uuid>` mint seed); the full definition lives in `data`
    // JSONB. updated_at / deleted_at mirror the federation LWW clock + tombstone
    // (a soft-deleted type is KEPT as a tombstone row so the deletion federates
    // — setUserCatalogTypes filters tombstones out of the active registry).
    // ≤64 rows, read whole on every warm/sync, so no secondary index (an unused
    // index is just write amplification). Mirrors the catalog_user_types block
    // in init-db.sql.
    `CREATE TABLE IF NOT EXISTS catalog_user_types (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Universe Builder records (Phase 3 Create migration, issue #1014). One row
    // per universe, the full sanitized record (canon bibles, categories,
    // compositeSheets, locks, influences) in `data` JSONB, moved out of
    // data/universes/{id}/index.json (collectionStore). Only the fields the
    // service/federation query, join, or sort on are mirrored into columns:
    // `name` (rename-cascade + delete-guard + list sort), `schema_version` (the
    // RECORD-shape version sanitizeTemplate stamps — a column so a future
    // migration can find unmigrated rows without parsing JSONB), `ephemeral`
    // (the snapshot loop filters local-only records), and the LWW/tombstone
    // trio (updated_at/deleted/deleted_at). NO sync_sequence: universes
    // federate via the EXISTING dataSync snapshot/push model (LWW on the body's
    // updatedAt), NOT catalog-style pull cursors — the storage swap is invisible
    // to peers (no schema-version bump). The mirror columns are populated FROM
    // the record body (mirrorTimestamp), not a DB trigger. Mirrors the universes
    // block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS universes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      schema_version INTEGER NOT NULL DEFAULT 4,
      ephemeral BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Partial index on the live set — the common list/scan path is "non-deleted
    // universes". updated_at supports LWW-staleness scans.
    `CREATE INDEX IF NOT EXISTS idx_universes_live ON universes (deleted) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_universes_updated ON universes (updated_at)`,

    // Universe render-history log (issue #1014). The type-level `config.runs[]`
    // array collectionStore kept in data/universes/index.json (capped 200,
    // NEVER federated — per-peer local) becomes its own table. `universe_id` is
    // a soft ref (no FK): the cascade-clean on universe delete is handled in the
    // service exactly as the file backend did, and a soft ref keeps the table
    // independent of universe-row insert ordering during the one-time import.
    // `data` holds jobIds[]/promptCount/collectionId. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS universe_runs (
      id TEXT PRIMARY KEY,
      universe_id TEXT NOT NULL,
      collection_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_universe_runs_universe ON universe_runs (universe_id, created_at DESC)`,

    // Pipeline series (Phase 3 Create migration, issue #1015). One row per
    // series, the full sanitized record (arc/seasons/locks/covers/style) in
    // `data` JSONB, moved out of data/pipeline-series/{id}/index.json
    // (collectionStore). Only the fields the service/federation query, join, or
    // sort on are mirrored into columns: `name` (rename-cascade + list sort),
    // `universe_id` (the hot relationship — the delete-guard "reject universe
    // delete when live series link it" + "series in this universe" lists; soft
    // ref, no FK — a series can sync before its universe arrives), and the
    // promote back-link `writers_room_work_id`. `ephemeral` + the LWW/tombstone
    // trio (updated_at/deleted/deleted_at) populated FROM the record body
    // (mirrorTimestamp), not a DB trigger. NO sync_sequence: pipeline records
    // federate via the EXISTING dataSync snapshot/push model — the storage swap
    // is invisible to peers (no schema-version bump). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS pipeline_series (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_series_universe ON pipeline_series (universe_id) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_series_wr_work ON pipeline_series (writers_room_work_id)`,
    `CREATE INDEX IF NOT EXISTS idx_series_updated ON pipeline_series (updated_at)`,

    // Pipeline issues (issue #1015). One row per issue; the 8-stage `stages`
    // map (text/visual/audio, runHistory, canonExtraction, covers) + lastRunId
    // pointers stay entirely in `data` JSONB (document-shaped, sanitizer-owned).
    // `series_id` (parent, soft ref), `season_id` (arc grouping), and `number`
    // (renumber-recomputed ordinal) are promoted — the renumber pass reads all
    // issues of a series ordered by number, the single most common cross-record
    // pipeline query, served directly by idx_issues_series (series_id, number).
    // `status` promoted for "issues needing review" dashboards. `ephemeral` +
    // LWW/tombstone trio mirror the body. NO sync_sequence (see pipeline_series).
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS pipeline_issues (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_issues_series ON pipeline_issues (series_id, number) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_issues_season ON pipeline_issues (season_id) WHERE season_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_issues_updated ON pipeline_issues (updated_at)`,

    // Story Builder sessions (issue #1016). One row per session; the conductor
    // bookkeeping (`steps` lock/integrity map, `syncedHashes` baseline,
    // `currentStep`, `llm` picker choice) stays entirely in `data` JSONB. The two
    // FKs `universe_id` / `series_id` are promoted for "sessions linked to this
    // record" lookups. `sync` is promoted because Story Builder is the one store
    // whose federation is OPT-IN — the snapshot loop filters WHERE sync = TRUE to
    // decide what to even consider pushing, so promoting it avoids deserializing
    // every session's `data` per snapshot tick. `ephemeral` + the LWW/tombstone
    // trio mirror the body. NO sync_sequence (sessions ride the existing dataSync
    // snapshot/LWW model, not the per-record push pipeline). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS story_builder_sessions (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stb_universe ON story_builder_sessions (universe_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stb_series ON story_builder_sessions (series_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stb_updated ON story_builder_sessions (updated_at)`,

    // Writers Room (Phase 3 Create migration, issue #1017). FOUR tables replace
    // the bespoke file layout (folders.json, exercises.json, per-work
    // manifest.json). Writers Room is NOT federated — it has no dataSync category
    // and no schema-version gate — so unlike the universe/pipeline/story-builder
    // tables these carry NO `ephemeral`/`sync`/sync_sequence columns and need no
    // mutation epoch. The only thing that stays on disk is the draft prose body
    // (drafts/<draftId>.md, file-primary); its metadata is the draft_versions row.

    // Folder tree. Self-ref parent_id (soft, no FK — nested tree). sort_order +
    // name promoted (the library renders the tree ordered by them). Mirrors
    // init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_folders_parent ON writers_room_folders (parent_id, sort_order)`,

    // Work manifests. The drafts[] array moves OUT of `data` into
    // writers_room_draft_versions (the one decomposition — draft versions are a
    // genuine 1-to-many the library + Phase-5 staleness analysis query). imageStyle
    // / liveMode / usage counters stay in `data`. `folder_id`, `title`, `kind`,
    // `status`, the promote/bridge links, and `active_draft_version_id` are
    // promoted for the library list + the resolver (#1018) + the bridge CTAs.
    // SOFT-DELETE added here (`deleted`/`deleted_at`): the file backend hard-deletes
    // via rm -rf; the DB backend aligns with the other stores (import sets
    // deleted = FALSE for all existing works). Soft ref everywhere — no FK.
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_works (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_works_folder ON writers_room_works (folder_id) WHERE deleted = FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_wr_works_series ON writers_room_works (pipeline_series_id) WHERE pipeline_series_id IS NOT NULL`,

    // Draft-version metadata index (file-primary bodies). The .md body stays on
    // disk at data/writers-room/works/<workId>/drafts/<draftId>.md; this row is
    // the queryable index over it: `content_file` (relative path), `content_hash`
    // (sha256 for staleness), `word_count`, `segment_index` (outline), version
    // lineage. asset-file-db-indexed pattern applied to prose. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_draft_versions (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_drafts_work ON writers_room_draft_versions (work_id, created_at)`,

    // Exercise sessions (sprint timer). Monolithic exercises.json → flat table.
    // `work_id`, `status`, started_at promoted for the per-work list (ordered by
    // started_at DESC). prompt/durations/word counts/appendedText stay in `data`.
    // Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS writers_room_exercises (
      id TEXT PRIMARY KEY,
      work_id TEXT,
      status VARCHAR(16),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_exercises_work ON writers_room_exercises (work_id, started_at DESC)`,
  ];
  for (const sql of catalogDDL) {
    await pool.query(sql);
  }
  console.log('🗄️ Database schema upgrades applied');
}

/**
 * Gracefully shut down the pool.
 */
export async function close() {
  await pool.end();
}

/**
 * Convert pgvector string representation to float array.
 * pgvector returns vectors as '[0.1,0.2,...]' strings.
 */
export function pgvectorToArray(vec) {
  if (Array.isArray(vec)) return vec;
  if (typeof vec === 'string') {
    return vec.replace(/^\[|\]$/g, '').split(',').map(Number);
  }
  return null;
}

/**
 * Format a float array (or pgvector string) as pgvector literal '[0.1,0.2,...]'
 */
export function arrayToPgvector(arr) {
  if (!arr) return null;
  if (typeof arr === 'string') return arr;
  return `[${arr.join(',')}]`;
}
