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
 * Get a client from the pool for transactions.
 * Caller must call client.release() when done.
 * @returns {Promise<pg.PoolClient>}
 */
export async function getClient() {
  return pool.connect();
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
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'sync_sequence') AS has_sync
    `);
    const { has_memories, has_links, has_sync } = result.rows[0];
    return { connected: true, hasSchema: has_memories && has_links && has_sync };
  } catch (err) {
    console.error(`🗄️ Database health check failed: ${err.message}`);
    return { connected: false, hasSchema: false, error: err.message };
  }
}

/**
 * Apply idempotent schema upgrades to an existing database.
 * Each statement uses IF NOT EXISTS so it's safe to run on every startup.
 * Add new ALTER TABLE statements here when the schema evolves.
 */
export async function ensureSchema() {
  const upgrades = [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS sync_sequence BIGSERIAL`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_instance_id VARCHAR(36)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_origin_instance ON memories (origin_instance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_sync_sequence ON memories (sync_sequence)`,
  ];
  for (const sql of upgrades) {
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
