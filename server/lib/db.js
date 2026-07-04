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
  max: 20,
  idleTimeoutMillis: 30000,
  // 10s (was 2s) — a single-user box periodically runs heavy local workloads
  // (Ollama model pulls, CoS agents) that can briefly delay establishing a
  // fresh loopback connection past a 2s window, causing spurious "timeout
  // exceeded when trying to connect" pool errors against a perfectly healthy
  // Postgres. 10s absorbs the busy moments while still failing fast on a real outage.
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error(`🗄️ Database pool error: ${err.message}`);
});

/**
 * Is the configured database a DESIGNATED test database?
 *
 * The test runner must NEVER touch a real (production) Postgres — there is only
 * ONE database per install (`PGDATABASE || 'portos'`), shared by every git
 * worktree, so a DB-backed `*.db.test.js` suite that does `DELETE FROM universes`
 * runs against the user's real authored content. (This is exactly how a CoS
 * agent running the suite in its worktree wiped every universe/series on
 * 2026-06-13.) A database is "safe for destructive tests" only when its name is
 * explicitly a test database (ends in `_test`, or the canonical `portos_test`)
 * or the operator sets `TEST_DB_OK=1` to opt a non-standard name in.
 *
 * Consumed by `checkHealth()` (skips DB suites on a non-test DB) and by the
 * destructive-statement guard in `query()` (a hard backstop).
 *
 * @returns {boolean}
 */
export function isTestDatabase() {
  if (process.env.TEST_DB_OK === '1') return true;
  const db = process.env.PGDATABASE || 'portos';
  return /_test$/.test(db) || db === 'portos_test';
}

/**
 * Are we executing under a test runner?
 *
 * `NODE_ENV === 'test'` alone is not reliable: a suite run from a CoS-agent
 * worktree (or any wrapper that sets NODE_ENV=development / leaves it unset)
 * still executes test code, and the backend selectors that key off NODE_ENV
 * (e.g. seriesStore's `useFileBackend()`) then quietly choose the *Postgres*
 * backend — so the test writes land in the real `portos` DB with the guard
 * below disarmed. Vitest always sets `process.env.VITEST` in every worker
 * process, so OR-ing it in arms the guard regardless of how NODE_ENV was
 * (mis)configured. This is the signal that actually closed the 2026-06-14
 * fixture leak into prod.
 *
 * @returns {boolean}
 */
export function isTestRunner() {
  return process.env.NODE_ENV === 'test' || process.env.VITEST != null;
}

// Guard ALL row writes — not just deletions. The original guard only blocked
// DELETE/TRUNCATE, which let a mis-pointed suite INSERT fixtures into prod
// (their cleanup DELETE then threw, *stranding* the rows) — exactly how test
// series/issues/story-builder fixtures leaked into the real `portos` DB and
// federated to peers. INSERT/UPDATE are now blocked too. Schema DDL
// (CREATE/ALTER/DROP) is still allowed: it is idempotent, carries no row-data,
// and ensureSchema() needs it to stand up portos_test.
//
// The first cut was `^`-anchored on a single leading verb, which let four
// less-obvious write forms slip past the "absolute backstop": data-modifying
// CTEs (`WITH … DELETE …`), `COPY … FROM` imports, `MERGE INTO`, and a write
// hiding after a leading read in a multi-statement batch (`SELECT 1; DELETE …`).
// No current store issues those forms, so this was latent rather than
// exploitable — but the guard is billed as the last line of defense, so it now
// matches a write verb ANYWHERE, after stripping comments so a keyword named in
// a comment can't trip it (and a write after a comment can't slip past).
//
// Normalize the SQL before keyword-matching in a SINGLE left-to-right pass that
// alternates over comments AND string literals, so whichever delimiter appears
// FIRST consumes its own span. Order matters and a two-pass "mask strings, then
// strip comments" is WRONG: an apostrophe inside a comment (`-- don't touch …`)
// would open a spurious string mask that swallows a real write on the next line
// (a false-negative — the exact failure this guard exists to prevent). Processing
// left-to-right keeps a comment's apostrophe part of the comment, and keeps a
// `/*` or `--` inside a string literal from starting a comment. Comments collapse
// to a space; string literals collapse to `''` (Postgres's escaped-quote form),
// so a write verb appearing only inside a literal can't trip the guard, and a
// quote-embedded comment delimiter can't hide a write between two literals.
// Dollar-quoted bodies (`$$…$$`, used in function definitions) are not unwrapped —
// stores don't send them, so this test-only backstop accepts that edge.
function normalizeSqlForMatch(text) {
  return text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g,
    (m) => (m[0] === "'" ? "''" : ' '),
  );
}

// CREATE TABLE … AS SELECT (CTAS) and the broader DDL family (CREATE/ALTER/DROP)
// are knowingly NOT matched: ensureSchema() needs DDL to stand up portos_test, and
// distinguishing a row-copying CTAS from a plain `CREATE TABLE … (col … GENERATED
// ALWAYS AS (…))` reliably needs paren-aware parsing this regex set deliberately
// avoids. No store issues CTAS, and the worst case on a mis-pointed run is a stray
// new table (schema pollution) rather than corruption of existing rows.
const ROW_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bMERGE\s+INTO\b/i,
  /\bTRUNCATE\b/i,
  // SELECT … INTO <table> creates and populates a new table (a real row write, not
  // DDL). Reads never carry a standalone INTO, so requiring SELECT before it keeps
  // this off ordinary queries; INSERT/MERGE INTO are caught by their own patterns.
  /\bSELECT\b[\s\S]+?\bINTO\b/i,
  // UPDATE … SET — the SET clause is what makes it a write, and distinguishes it
  // from a `SELECT … FOR UPDATE` / `FOR NO KEY UPDATE` row-lock read. `[^;]+?`
  // keeps the match inside one statement so `… FOR UPDATE; SET search_path …`
  // (a read followed by a session command) doesn't read as an UPDATE write.
  /\bUPDATE\b\s+[^;]+?\bSET\b/i,
  // COPY <table> FROM — an import writes rows. `COPY (query) TO` / `COPY <table>
  // TO` is an export (read): requiring the first non-blank token after COPY to be
  // a non-`(` char (`[^\s(]`) rejects the subquery-export form whose inner FROM
  // would otherwise match, and requiring FROM before the next `;` leaves `COPY
  // <table> TO …` (no FROM) alone. `[^\s(]` (not a `(?!\()` lookahead) is load-
  // bearing: a lookahead lets `\s+` backtrack and pass the assertion mid-whitespace
  // on `COPY   (SELECT … FROM …) TO`, so the export would false-positive.
  /\bCOPY\s+[^\s(][^;]*?\bFROM\b/i,
];

// True when the SQL performs a row write in any of the recognized forms.
function isRowWriteSql(text) {
  const sql = normalizeSqlForMatch(text);
  return ROW_WRITE_PATTERNS.some((re) => re.test(sql));
}

/**
 * Hard backstop: under the test runner, refuse to MUTATE a non-test database.
 * Throws (fail loudly) on any row write — INSERT/UPDATE/DELETE/TRUNCATE/MERGE,
 * COPY … FROM imports, data-modifying CTEs, and a write hidden in a multi-
 * statement batch — instead of silently writing (or stranding) real data. Reads
 * (SELECT, including COPY … TO exports) and schema DDL are left alone so
 * health/version probes and ensureSchema() still work.
 *
 * Shared by BOTH the pool `query()` wrapper and the per-transaction client in
 * `withTransaction()`. The transaction path is critical: nearly every store
 * mutation (updateAuthor, deleteAuthor, mergeAuthorsFromSync, universe runs,
 * catalog, writers-room) runs its writes through `client.query()` inside a
 * transaction — which talks to the raw pg client, NOT this module's `query()`.
 * Guarding only `query()` left that path wide open: a suite under VITEST that
 * reached any transaction write path wrote straight into the real `portos` DB.
 *
 * @param {string} text - SQL query text
 */
export function assertWriteAllowed(text) {
  if (
    isTestRunner() &&
    !isTestDatabase() &&
    typeof text === 'string' &&
    isRowWriteSql(text)
  ) {
    throw new Error(
      `🛑 Refusing to mutate non-test database '${process.env.PGDATABASE || 'portos'}' under the test runner. ` +
        `Point PGDATABASE at a *_test database (e.g. portos_test), gate the suite on requireDb(), or set TEST_DB_OK=1. Query: ${text.slice(0, 80)}`,
    );
  }
}

// Proxy handler that runs a pg client's row writes through assertWriteAllowed.
// Defined once at module scope (not per-transaction): the `get` trap receives
// the client as `target`, so a single shared handler guards every client
// withTransaction() wraps — no per-call handler/closure allocation. A Proxy
// (rather than an object-spread copy) is required because pg's client methods
// live on the prototype, which a spread would not carry.
const GUARDED_CLIENT_HANDLER = {
  get(target, prop, receiver) {
    if (prop === 'query') {
      return (config, ...rest) => {
        const sql = typeof config === 'string' ? config : config?.text;
        assertWriteAllowed(sql);
        return target.query(config, ...rest);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
};

/**
 * Execute a query against the connection pool.
 * @param {string} text - SQL query text with $1, $2, etc. placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  // Hard backstop: refuse to mutate a non-test DB under the runner even if a
  // suite reaches query() without gating on checkHealth() first (a new test
  // author calls query('INSERT …') directly, or a backend selector mis-chose
  // Postgres because NODE_ENV wasn't 'test').
  assertWriteAllowed(text);
  return pool.query(text, params);
}

/**
 * Read the connected server's PostgreSQL major version (e.g. 17 for 17.10).
 *
 * `server_version_num` is an integer like 170010 → major = floor(n / 10000).
 * Used by the backup service to select a `pg_dump` whose major version is
 * >= the server's: pg_dump aborts with "server version mismatch" when it is
 * older than the server it dumps, which is the common Homebrew footgun where
 * an older `postgresql@NN` keg shadows the running server in PATH.
 *
 * @returns {Promise<number|null>} major version, or null if unreachable/unparseable
 */
export async function getServerMajorVersion() {
  const result = await query('SHOW server_version_num').catch(() => null);
  const num = parseInt(result?.rows?.[0]?.server_version_num, 10);
  if (!Number.isFinite(num)) return null;
  return Math.floor(num / 10000);
}

/**
 * Run a function inside a database transaction.
 * Auto-commits on success, rolls back on error.
 * @param {function(pg.PoolClient): Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  // Guard the client's row writes with the same backstop as query(). The raw
  // pg client bypasses query() entirely, so without this wrapper a test-runner
  // process pointed at the real `portos` DB writes through every store's
  // transaction path unguarded (see assertWriteAllowed). BEGIN/COMMIT/ROLLBACK
  // below call the raw client directly (they are not row writes). pg's
  // client.query accepts either a SQL string or a { text, values } config —
  // GUARDED_CLIENT_HANDLER reads the SQL out of both.
  const guardedClient = new Proxy(client, GUARDED_CLIENT_HANDLER);
  await client.query('BEGIN');
  let result;
  try {
    result = await fn(guardedClient);
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
  // Test-runner safety gate. Under the test runner the only database we permit
  // is a designated test database (see isTestDatabase). Reporting "disconnected"
  // here makes every DB-backed `*.db.test.js` suite skip via its existing
  // `if (!health.connected)` branch — instead of running DELETE FROM against the
  // developer's real universes/series/writing. Keyed on isTestRunner() (not bare
  // NODE_ENV) so a worktree run that left NODE_ENV unset is still gated. The
  // mocked checkHealth in memoryBackend.test.js / backup.test.js is unaffected
  // (it replaces this fn).
  if (isTestRunner() && !isTestDatabase()) {
    return {
      connected: false,
      hasSchema: false,
      hasCatalogSchema: false,
      error: `test runner blocked from non-test database '${process.env.PGDATABASE || 'portos'}' — point PGDATABASE at a *_test database (e.g. portos_test) or set TEST_DB_OK=1`,
    };
  }
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
// Every DB-backed store self-runs ensureSchema() when it warms its backend at
// boot (memory, creative-director, media index, catalog, universe/story/writers
// stores, pipeline series/issues, plus the boot DB gate). Those warm
// sequentially, so the in-flight dedup above can't collapse them — each re-runs
// the idempotent DDL (cheap no-ops) and would otherwise re-log the same line.
// Log it once per process so the boot output isn't a wall of identical lines.
let schemaUpgradeLogged = false;

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
    `CREATE TABLE IF NOT EXISTS tribe_people (
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
    )`,
    // Known emails/handles for a person — the deterministic key that maps a
    // calendar attendee / message counterpart back to this tracked person so
    // touchpoints can be auto-logged (#2033).
    `ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS emails TEXT[] DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_live ON tribe_people (deleted, ring, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_tags ON tribe_people USING gin (tags)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_people_emails ON tribe_people USING gin (emails)`,
    `CREATE TABLE IF NOT EXISTS tribe_touchpoints (
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
    )`,
    // Idempotency key for auto-logged touchpoints (calendar event id / message
    // thread+day). Partial unique index so re-syncs never double-log a person
    // for the same event/thread-day; NULL for hand-logged user touchpoints.
    `ALTER TABLE tribe_touchpoints ADD COLUMN IF NOT EXISTS dedupe_key TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_person ON tribe_touchpoints (person_id, happened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_touchpoints_calendar ON tribe_touchpoints (calendar_account_id, calendar_event_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tribe_touchpoints_dedupe ON tribe_touchpoints (person_id, dedupe_key) WHERE dedupe_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS tribe_memory_links (
      person_id UUID NOT NULL REFERENCES tribe_people(id) ON DELETE CASCADE,
      memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (person_id, memory_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tribe_memory_links_memory ON tribe_memory_links (memory_id)`,
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
    // queries. `listProjects` sorts by created_at. `status` is app-layer gated
    // (PROJECT_STATUSES), no DB CHECK. As of #1564 projects FEDERATE across peers
    // via the per-record peer-sync push pipeline (record kind
    // `creativeDirectorProject`, sync category `creativeDirectorProjects`), so
    // the soft-delete tombstone trio (deleted/deleted_at + LWW updated_at) mirrors
    // the authors table — a delete is a tombstone the merge keeps an out-of-date
    // peer from resurrecting. Mirrors the creative_director_projects block in
    // init-db.sql; the ADD COLUMN upgrades below backfill existing installs.
    `CREATE TABLE IF NOT EXISTS creative_director_projects (
      id TEXT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Backfill the tombstone columns on installs created before #1564 (the
    // CREATE above is a no-op once the table exists). The partial index serves
    // the live-list filter (deleted = FALSE).
    `ALTER TABLE creative_director_projects ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE creative_director_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_creative_director_projects_live ON creative_director_projects (deleted) WHERE deleted = FALSE`,

    // Music Video projects (issue #1760). The director scene board's db-primary
    // record: id/status/created_at/updated_at mirrored as columns, the full
    // project (track link, cached audioAnalysis, scenes[]) in `data` JSONB —
    // same shape as creative_director_projects. The soft-delete tombstone trio is
    // present so peer-sync federation (a follow-up) is additive. Mirrors the
    // music_video_projects block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS music_video_projects (
      id TEXT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `ALTER TABLE music_video_projects ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE music_video_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_music_video_projects_live ON music_video_projects (deleted) WHERE deleted = FALSE`,

    // Mood boards (issue #911). A dedicated inspiration/mood-board canvas,
    // distinct from raw Media History, for collecting visual + textual
    // references that feed the Create suite. One row per board, the full record
    // (name/description/items[]) in `data` JSONB. Items (image-by-media-key or
    // external URL, or a text note + optional caption/source backref) live
    // inline in the board's JSONB rather than a child table — a board is read/
    // written whole, has a small bounded item list, and there are no cross-board
    // item queries. `name` mirrors a column for the live-list sort. As of #1564
    // mood boards FEDERATE across peers via the per-record peer-sync push pipeline
    // (record kind `moodBoard`, sync category `moodBoards`), so the soft-delete
    // tombstone trio (deleted/deleted_at + LWW updated_at) mirrors
    // creative_director_projects — a delete is a tombstone the merge keeps an
    // out-of-date peer from resurrecting. Mirrors the mood_boards block in
    // init-db.sql; the ADD COLUMN upgrades below backfill existing installs.
    `CREATE TABLE IF NOT EXISTS mood_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    // Backfill the tombstone columns on installs created before #1564 (the
    // CREATE above is a no-op once the table exists).
    `ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE mood_boards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    // updated_at DESC is the board-list "recently touched" sort.
    `CREATE INDEX IF NOT EXISTS idx_mood_boards_updated ON mood_boards (updated_at DESC)`,
    // Partial index for the live-list filter (deleted = FALSE).
    `CREATE INDEX IF NOT EXISTS idx_mood_boards_live ON mood_boards (deleted) WHERE deleted = FALSE`,

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

    // Author personas. One row per reusable author/byline persona, the full
    // sanitized record (name, writingStyle, bio, physicalDescription,
    // headshotStyle, headshotImageUrl) in `data` JSONB. `name` mirrors a column
    // for the live-list sort; the LWW/tombstone trio (updated_at/deleted/
    // deleted_at) is populated FROM the record body. Authors are db-primary AND
    // federated via the per-record peer-sync push pipeline (record kind `author`,
    // sync category `authors`); a federated series also keeps its denormalized
    // `author` byline so a peer that hasn't synced the persona still renders the
    // cover correctly. Mirrors the authors block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_authors_live ON authors (deleted) WHERE deleted = FALSE`,

    // Music artists (the Music studio's persona store — analogue of authors).
    // One row per artist, the full sanitized record (name, genre, bio,
    // musicalStyle, physicalDescription, portraitStyle, portraitImageUrl) in
    // `data` JSONB. `name` mirrors a column for the live-list sort; the LWW/
    // tombstone trio is populated FROM the record body. Artists are db-primary
    // and federation-ready (LWW merge mirrors authors), but the artist record
    // kind is not yet registered in peerSync — local-only for now (see issue #1502).
    // Mirrors the artists block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_artists_live ON artists (deleted) WHERE deleted = FALSE`,

    // Music albums (the Music studio). One row per album, the full sanitized
    // record (title, artistId+denormalized artist, description, genre,
    // releaseYear, coverImageUrl, ordered trackIds) in `data` JSONB. `title`
    // mirrors a column for the live-list sort. db-primary + federation-ready
    // (LWW merge mirrors artists), not yet registered in peerSync — local-only
    // for now (see issue #1502). Mirrors the albums block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_albums_live ON albums (deleted) WHERE deleted = FALSE`,

    // Music tracks (the Music studio). One row per track, the full sanitized
    // record (title, albumId/artistId FKs + denormalized artist, lyrics, prompt,
    // engine/modelId/durationSec gen metadata, audioFilename pointing into the
    // shared music library at data/music/) in `data` JSONB. `title` mirrors a
    // column for queries. db-primary + federation-ready, not yet registered in
    // peerSync — local-only for now (see issue #1502). Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_live ON tracks (deleted) WHERE deleted = FALSE`,

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
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_folders_parent ON writers_room_folders (parent_id, sort_order)`,
    // Idempotent upgrade for installs predating folder federation (#1645): without
    // the soft-delete columns an old install boots the new code and hard-DELETEs a
    // folder (no tombstone) — peers never learn it was removed and resurrect it.
    `ALTER TABLE writers_room_folders ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE writers_room_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,

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
      finished_at TIMESTAMPTZ,
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wr_exercises_work ON writers_room_exercises (work_id, started_at DESC)`,
    // Idempotent upgrade for installs predating exercise federation (#1645). The
    // tombstone columns let a peer's deletion propagate (LWW never propagates a
    // hard delete); no current path deletes an exercise but a future peer might.
    `ALTER TABLE writers_room_exercises ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE writers_room_exercises ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,

    // LoRA training runs (character LoRA training). MUST live here, not only
    // in init-db.sql — init-db.sql runs only on fresh `db.sh setup-native`
    // provisioning, so existing installs + federated peers get new tables
    // exclusively through this boot-time upgrade path. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS lora_training_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      character_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lora_training_runs_status ON lora_training_runs (status)`,
    `CREATE INDEX IF NOT EXISTS idx_lora_training_runs_character ON lora_training_runs (character_id)`,

    // ─── Privacy Center: PII Vault (issue #2140, epic #2138) ─────────────────
    // Encrypted-at-rest identity facts. `value_enc` is AES-256-GCM ciphertext
    // (`v1:<iv>:<tag>:<ct>`, key from PRIVACY_VAULT_KEY — lib/vaultCrypto.js);
    // plaintext is NEVER stored, `masked_value` is the display form. Machine-
    // local: no federation, no tombstones (deferred, #2148) — a delete is a
    // hard DELETE. `use_for_scans` gates which facts the broker scan engine
    // may disclose (hard-false for ssn/passport/drivers_license/
    // financial_account — enforced app-side). Mirrors the privacy blocks in
    // init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_vault_records (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      value_enc TEXT NOT NULL,
      masked_value TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'current',
      valid_from DATE,
      valid_to DATE,
      share_with_twin BOOLEAN NOT NULL DEFAULT FALSE,
      use_for_scans BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Type is the primary list filter (all addresses, all emails, ...).
    `CREATE INDEX IF NOT EXISTS idx_privacy_vault_records_type ON privacy_vault_records (type)`,
    // Explicit consent audit rows (v1 subject is always 'self'); the broker
    // opt-out engine builds on this trail. Append-only.
    `CREATE TABLE IF NOT EXISTS privacy_consents (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT 'self',
      scope TEXT NOT NULL,
      method TEXT NOT NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ─── Deletion audit log (incident #1248-follow-up) ──────────────────────
    // Append-only forensic trail of EVERY tombstone (soft-delete), un-tombstone
    // (recovery), and hard-delete of user-authored records — written by a DB
    // trigger so it captures deletions from ANY source: the app, a test suite
    // doing raw `DELETE FROM`, or a manual `psql` session. (On 2026-06-13 a CoS
    // agent's test run wiped every universe/series with no trace of who/when;
    // this table closes that gap.) `row_snapshot` keeps the OLD row JSON so a
    // wrongful delete is recoverable from the log alone. Local-only, never
    // federated (no sync_sequence) — each install audits its own mutations.
    // Mirrors the record_audit block in init-db.sql (parity-locked by
    // db.catalogDdlParity.test.js).
    `CREATE TABLE IF NOT EXISTS record_audit (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_record ON record_audit (table_name, record_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_occurred ON record_audit (occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_action ON record_audit (action, occurred_at DESC)`,

    // Generic audit trigger. Works on any table via to_jsonb(OLD/NEW) so it needs
    // no per-table column knowledge: `id`/`name`/`title`/`deleted`/`deleted_at`
    // are read out of the row JSON (absent keys → NULL). A row is "deleted" when
    // its `deleted` boolean is true OR its `deleted_at` is non-null (covers both
    // the bool-trio tables and catalog_user_types' deleted_at-only shape).
    // `actor` reads the optional `portos.actor` GUC the app MAY set per session;
    // `source_query` captures current_query() so even an un-attributed raw DELETE
    // is traceable. AFTER trigger: only committed-path rows are logged.
    `CREATE OR REPLACE FUNCTION record_audit_log()
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
     $$ LANGUAGE plpgsql`,
  ];

  // Attach the audit trigger to every user-authored-content table. Adding a
  // table here is all it takes to audit its deletions. (Keep in sync with the
  // AUDITED_RECORD_TABLES list in init-db.sql.)
  const auditedTables = [
    'universes', 'universe_runs', 'pipeline_series', 'pipeline_issues',
    'story_builder_sessions', 'writers_room_works', 'writers_room_folders',
    'writers_room_draft_versions', 'catalog_ingredients', 'catalog_scraps',
    'catalog_user_types', 'creative_director_projects', 'mood_boards',
    'lora_training_runs', 'authors', 'artists', 'albums', 'tracks', 'tribe_people', 'tribe_touchpoints',
  ];
  for (const t of auditedTables) {
    catalogDDL.push(`DROP TRIGGER IF EXISTS trg_${t}_audit ON ${t}`);
    catalogDDL.push(
      `CREATE TRIGGER trg_${t}_audit AFTER UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION record_audit_log()`,
    );
  }

  for (const sql of catalogDDL) {
    await pool.query(sql);
  }
  if (!schemaUpgradeLogged) {
    console.log('🗄️ Database schema upgrades applied');
    schemaUpgradeLogged = true;
  }
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
