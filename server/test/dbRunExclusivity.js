/**
 * Global setup for `vitest.config.db.js`: one DB suite run at a time per `portos_test`.
 *
 * There is ONE Postgres per install and every git worktree shares its
 * `portos_test`. `fileParallelism: false` only serializes files inside one
 * Vitest process; a second run from another worktree (parallel claim agents)
 * overlaps it. Suites like `backup.db.test.js` restore a whole-database dump
 * (`--clean`), which discards every other run's fixture rows mid-case — the
 * `Production project not found` flake in `stages.db.test.js` (#12371).
 *
 * A session-level advisory lock on the test database is held for the whole
 * run. It is connection-scoped, so a killed run releases it automatically.
 */
// Distinct from SCHEMA_DDL_ADVISORY_LOCK_KEY (5977001, lib/db.js) — ensureSchema
// takes that one inside a run and would otherwise deadlock against this holder.
export const DB_RUN_ADVISORY_LOCK_KEY = 5977002;

const WAIT_LOG_INTERVAL_MS = 30_000;

// `pg` loads lazily: a run that skips the lock (non-test database) never needs it.

/** Connection target for the test database, mirroring lib/db.js defaults. */
function testDatabaseConfig(env) {
  return {
    host: env.PGHOST || 'localhost',
    port: parseInt(env.PGPORT || '5432', 10),
    database: env.PGTESTDATABASE || 'portos_test',
    user: env.PGUSER || 'portos',
    password: env.PGPASSWORD || 'portos',
  };
}

/**
 * Acquire the run lock. Resolves to a release function; resolves to a no-op
 * when the database is unreachable or not a `_test` database (the suites then
 * skip themselves via requireDbOrSkip, so there is nothing to protect).
 */
export async function acquireDbRunLock({
  env = process.env,
  createClient = async config => new (await import('pg')).default.Client(config),
  log = console.log,
  waitLogIntervalMs = WAIT_LOG_INTERVAL_MS,
} = {}) {
  const config = testDatabaseConfig(env);
  if (!/_test$/.test(config.database)) return async () => {};

  const client = await createClient(config);
  client.on?.('error', () => {});
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => {});
    return async () => {};
  }

  const { rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DB_RUN_ADVISORY_LOCK_KEY]);
  if (!locked) {
    log(`⏳ Another DB test run holds ${config.database} — waiting for it to finish…`);
    const timer = setInterval(() => log(`⏳ Still waiting for the DB test run holding ${config.database}…`), waitLogIntervalMs);
    timer.unref?.();
    await client.query('SELECT pg_advisory_lock($1)', [DB_RUN_ADVISORY_LOCK_KEY]).finally(() => clearInterval(timer));
  }

  return async () => {
    await client.query('SELECT pg_advisory_unlock($1)', [DB_RUN_ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  };
}

export async function setup() {
  return acquireDbRunLock();
}
