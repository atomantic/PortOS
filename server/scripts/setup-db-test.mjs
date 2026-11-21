#!/usr/bin/env node
/**
 * Provision the throwaway TEST database (default `portos_test`) and apply the
 * full schema (init-db.sql).
 *
 * Why: the DB-backed `*.db.test.js` suites talk to a real Postgres and run
 * `DELETE FROM …` in setup. They are HARD-BLOCKED from the production `portos`
 * database (see isTestDatabase() in server/lib/db.js) and skip unless PGDATABASE
 * names a `*_test` database. This script creates that database so the suites can
 * actually run — against data nobody cares about — restoring real coverage of
 * the DB adapter layer without ever risking your authored content.
 *
 * Idempotent: re-running CREATEs nothing it already has (CREATE DATABASE is
 * guarded by a pg_database probe; init-db.sql is all IF NOT EXISTS).
 *
 *   node server/scripts/setup-db-test.mjs          # local: creates portos_test
 *   npm run setup:db:test                          # same, via package.json
 *
 * Connection uses standard PG env (PGHOST/PGPORT/PGUSER/PGPASSWORD). The target
 * name is PGTESTDATABASE (default `portos_test`); the maintenance connection
 * used to issue CREATE DATABASE is PGADMINDATABASE (default `portos`, which
 * always exists on a provisioned install).
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDirectlyInvoked } from '../../scripts/lib/directInvocation.js';
import { checkDbTestStorage } from './dbTestStorage.mjs';
import { describeSetupFailure } from './setupDbTestFailure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function provisionTestDatabase({
  env = process.env,
  createClient = config => new pg.Client(config),
  storage = {},
  log = console.log,
} = {}) {
  const testDb = env.PGTESTDATABASE || 'portos_test';
  // CREATE DATABASE cannot parameterize its identifier.
  if (!/^[a-z][a-z0-9_]*_test$/.test(testDb)) {
    throw new Error('test DB name must match /^[a-z][a-z0-9_]*_test$/');
  }
  const conn = {
    host: env.PGHOST || 'localhost',
    port: parseInt(env.PGPORT || '5432', 10),
    user: env.PGUSER || 'portos',
    password: env.PGPASSWORD || 'portos',
  };
  // 1. Create the database if absent (from a maintenance connection — CREATE
  //    DATABASE cannot run inside the target DB or a transaction).
  const admin = createClient({ ...conn, database: env.PGADMINDATABASE || 'portos' });
  try {
    await admin.connect();
    await checkDbTestStorage(admin, { ...storage, host: conn.host, log });
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${testDb}`);
      log(`🗄️ Created test database '${testDb}'`);
    } else {
      log(`🗄️ Test database '${testDb}' already exists`);
    }
  } finally {
    await admin.end().catch(() => {});
  }

  // 2. Apply the schema. node-postgres runs a multi-statement string in one
  //    simple-query call (no params), so the whole init-db.sql — including the $$
  //    function bodies — applies as a single batch.
  const sql = readFileSync(join(HERE, 'init-db.sql'), 'utf8');
  const client = createClient({ ...conn, database: testDb });
  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end().catch(() => {});
  }
  log(`✅ Schema applied to '${testDb}'. Run the DB suites with: npm run test:db --prefix server`);
}

// A failure must end the process non-zero with one readable line: pregate and CI
// treat the exit status as the only provisioning verdict.
if (isDirectlyInvoked(import.meta.url)) {
  try {
    await provisionTestDatabase();
  } catch (error) {
    const testDb = process.env.PGTESTDATABASE || 'portos_test';
    console.error(`❌ Failed to provision '${testDb}': ${describeSetupFailure(error, testDb)}`);
    process.exitCode = 1;
  }
}
