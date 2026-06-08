/**
 * Live-DB test for the versioned DB-migration runner (#1029).
 *
 * Like the other db.test.js suites, this needs a live PostgreSQL with the base
 * schema applied. If no DB is reachable it SKIPS cleanly. When a DB IS reachable
 * it proves the four contract points:
 *   1. applies an unapplied migration (both .sql and .js variants),
 *   2. records each applied migration in schema_migrations,
 *   3. skips already-applied migrations on re-run (idempotent),
 *   4. a failing migration rolls back AND is NOT recorded (atomicity).
 *
 * It writes throwaway fixture files into a temp directory (not the real
 * db-migrations/ tree) and cleans up its schema_migrations rows + scratch table
 * afterward so a developer's DB is left untouched.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkHealth, ensureSchema, query, withTransaction, close } from '../lib/db.js';
import { runDbMigrations } from './run-db-migrations.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'schema_migrations table not present';
  }
}

if (!dbReady) console.log(`⏭️  run-db-migrations.test.js skipped: ${skipReason}`);

// Test fixtures use a unique id prefix so we can clean ONLY our own rows /
// scratch tables without touching a developer's real migration history.
const PREFIX = `ztest${Date.now()}_`;
const SCRATCH = `${PREFIX}scratch`;

const db = { query, withTransaction };

describe.skipIf(!dbReady)('versioned DB-migration runner', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'db-mig-test-'));
  });

  beforeEach(async () => {
    await query(`DELETE FROM schema_migrations WHERE id LIKE '${PREFIX}%'`);
    await query(`DROP TABLE IF EXISTS ${SCRATCH}`);
  });

  afterAll(async () => {
    await query(`DELETE FROM schema_migrations WHERE id LIKE '${PREFIX}%'`).catch(() => {});
    await query(`DROP TABLE IF EXISTS ${SCRATCH}`).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await close();
  });

  it('applies an unapplied .sql migration and records it', async () => {
    const file = `${PREFIX}001-create.sql`;
    const d = await mkdtemp(join(tmpdir(), 'db-mig-sql-'));
    await writeFile(join(d, file), `CREATE TABLE ${SCRATCH} (id TEXT PRIMARY KEY);`);

    const ran = await runDbMigrations({ migrationsDir: d, db });
    expect(ran).toBe(1);

    const exists = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS ok`,
      [SCRATCH],
    );
    expect(exists.rows[0].ok).toBe(true);

    const rec = await query(`SELECT id FROM schema_migrations WHERE id = $1`, [file]);
    expect(rec.rows).toHaveLength(1);

    await rm(d, { recursive: true, force: true });
  });

  it('applies a .js migration via its up(client) export', async () => {
    const file = `${PREFIX}001-js.js`;
    const d = await mkdtemp(join(tmpdir(), 'db-mig-js-'));
    await writeFile(
      join(d, file),
      `export async function up(client) { await client.query('CREATE TABLE ${SCRATCH} (id TEXT PRIMARY KEY)'); }`,
    );

    const ran = await runDbMigrations({ migrationsDir: d, db });
    expect(ran).toBe(1);

    const exists = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS ok`,
      [SCRATCH],
    );
    expect(exists.rows[0].ok).toBe(true);

    await rm(d, { recursive: true, force: true });
  });

  it('skips an already-applied migration on re-run (idempotent)', async () => {
    const file = `${PREFIX}001-create.sql`;
    const d = await mkdtemp(join(tmpdir(), 'db-mig-idem-'));
    await writeFile(join(d, file), `CREATE TABLE ${SCRATCH} (id TEXT PRIMARY KEY);`);

    expect(await runDbMigrations({ migrationsDir: d, db })).toBe(1);
    // Second run: nothing pending — the CREATE TABLE (no IF NOT EXISTS) would
    // throw "already exists" if it re-ran, so a clean 0 proves the skip.
    expect(await runDbMigrations({ migrationsDir: d, db })).toBe(0);

    const rec = await query(`SELECT id FROM schema_migrations WHERE id = $1`, [file]);
    expect(rec.rows).toHaveLength(1);

    await rm(d, { recursive: true, force: true });
  });

  it('rolls back a failing migration and does NOT record it', async () => {
    const file = `${PREFIX}001-bad.sql`;
    const d = await mkdtemp(join(tmpdir(), 'db-mig-fail-'));
    // Create a scratch table, then issue invalid SQL in the SAME migration. The
    // CREATE must roll back with the failure — proving transactional atomicity.
    await writeFile(
      join(d, file),
      `CREATE TABLE ${SCRATCH} (id TEXT PRIMARY KEY);\nINSERT INTO ${SCRATCH} (nonexistent_column) VALUES ('x');`,
    );

    await expect(runDbMigrations({ migrationsDir: d, db })).rejects.toThrow();

    // The scratch table CREATE rolled back with the bad INSERT.
    const exists = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS ok`,
      [SCRATCH],
    );
    expect(exists.rows[0].ok).toBe(false);

    // And it was NOT marked applied — a re-run would retry it.
    const rec = await query(`SELECT id FROM schema_migrations WHERE id = $1`, [file]);
    expect(rec.rows).toHaveLength(0);

    await rm(d, { recursive: true, force: true });
  });

  it('returns 0 for a missing migrations directory', async () => {
    const ran = await runDbMigrations({ migrationsDir: join(dir, 'does-not-exist'), db });
    expect(ran).toBe(0);
  });

  it('ignores _-prefixed helpers and *.test.js files', async () => {
    const d = await mkdtemp(join(tmpdir(), 'db-mig-ignore-'));
    await writeFile(join(d, `_helper.js`), `export const x = 1;`);
    await writeFile(join(d, `${PREFIX}thing.test.js`), `export function up() {}`);
    const ran = await runDbMigrations({ migrationsDir: d, db });
    expect(ran).toBe(0);
    await rm(d, { recursive: true, force: true });
  });
});
