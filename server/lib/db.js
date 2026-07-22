/**
 * Database Connection Pool
 *
 * PostgreSQL connection management for the memory system.
 * Uses pg (node-postgres) with a connection pool for efficient query execution.
 */

import pg from 'pg';
import { buildUpgradeDdl, buildCatalogDdl } from './db/schema/index.js';

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
  // ⚠️ Boot CREATE INDEX lock window. Every `CREATE INDEX IF NOT EXISTS` below
  // (and in the catalogDDL block, incl. the HNSW vector index on catalog_scraps)
  // runs as a plain, non-CONCURRENT build. The FIRST time an index materializes
  // on a table that ALREADY holds many rows, Postgres takes a SHARE lock that
  // blocks writes (INSERT/UPDATE/DELETE) to that table until the build finishes —
  // so an existing install upgrading into a new index sees a one-time write stall
  // at boot proportional to that table's row count (HNSW builds are the slowest).
  //   Why this is left as-is rather than switched to CONCURRENTLY:
  //   - Fresh installs (the common case) build every index on an EMPTY table, so
  //     the lock is effectively instant — there is nothing to block.
  //   - CREATE INDEX CONCURRENTLY cannot run inside a transaction block, needs its
  //     own retry/cleanup path (a failed CONCURRENT build leaves an INVALID index
  //     that must be dropped by hand), and roughly doubles build time — fragile to
  //     run unattended on every boot for a stall that only bites large-table upgrades.
  //   If a future index must land on a table known to already carry a large row
  //   count on existing installs, note that the standard db-migration runner
  //   (server/scripts/run-db-migrations.js) wraps every migration in a
  //   withTransaction() block, so CREATE INDEX CONCURRENTLY CANNOT run there
  //   either — it must be issued from a dedicated non-transactional path (a
  //   standalone maintenance script / manual step run outside any transaction).
  //   See docs/STORAGE.md ("Boot schema upgrades & the CREATE INDEX lock window").
  const upgrades = buildUpgradeDdl();
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

  const catalogDDL = buildCatalogDdl();

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
