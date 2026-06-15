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

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_DB = process.env.PGTESTDATABASE || 'portos_test';

// Guard the identifier — it's interpolated into CREATE DATABASE (which can't be
// parameterized), so refuse anything but a plain, test-suffixed name.
if (!/^[a-z][a-z0-9_]*_test$/.test(TEST_DB)) {
  console.error(`❌ Refusing to provision '${TEST_DB}': test DB name must match /^[a-z][a-z0-9_]*_test$/`);
  process.exit(1);
}

const conn = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'portos',
  password: process.env.PGPASSWORD || 'portos',
};

// 1. Create the database if absent (from a maintenance connection — CREATE
//    DATABASE cannot run inside the target DB or a transaction).
const admin = new pg.Client({ ...conn, database: process.env.PGADMINDATABASE || 'portos' });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  console.log(`🗄️ Created test database '${TEST_DB}'`);
} else {
  console.log(`🗄️ Test database '${TEST_DB}' already exists`);
}
await admin.end();

// 2. Apply the schema. node-postgres runs a multi-statement string in one
//    simple-query call (no params), so the whole init-db.sql — including the $$
//    function bodies — applies as a single batch.
const sql = readFileSync(join(HERE, 'init-db.sql'), 'utf8');
const client = new pg.Client({ ...conn, database: TEST_DB });
await client.connect();
await client.query(sql);
await client.end();
console.log(`✅ Schema applied to '${TEST_DB}'. Run the DB suites with: npm run test:db --prefix server`);
