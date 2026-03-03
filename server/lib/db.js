/**
 * Database Connection Pool
 *
 * PostgreSQL connection management for the memory system.
 * Uses pg (node-postgres) with a connection pool for efficient query execution.
 */

import pg from 'pg';

const { Pool } = pg;

// Connection config from environment or defaults
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5561', 10),
  database: process.env.PGDATABASE || 'portos',
  user: process.env.PGUSER || 'portos',
  password: process.env.PGPASSWORD || 'portos',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
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
    const result = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories') AS has_table"
    );
    return { connected: true, hasSchema: result.rows[0].has_table };
  } catch (err) {
    return { connected: false, hasSchema: false, error: err.message };
  }
}

/**
 * Gracefully shut down the pool.
 */
export async function close() {
  await pool.end();
}
