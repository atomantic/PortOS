/**
 * Real psql/pg_dump regression for restoring a pre-federation folder schema.
 * Runs only via test:db against a guarded test database, never live records.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkHealth, ensureSchema, query, close, POOL_CONFIG } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { runDbMigrations } from '../scripts/run-db-migrations.js';
import { restorePostgres } from './backup.js';
import { listFolders } from './writersRoom/db.js';

const health = await checkHealth();
const ready = requireDbOrSkip('services/backup.db.test',
  health.connected && spawnSync('psql', ['--version']).status === 0 &&
    spawnSync('pg_dump', ['--version']).status === 0,
  'test database or PostgreSQL client tools unavailable');
let dest;
const folderId = 'restore-schema-folder-probe';
const issueId = 'restore-schema-issue-probe';
const pendingMigration = '007-storyboard-scene-durable-ids.js';

afterAll(async () => {
  if (ready) {
    await ensureSchema({ force: true });
    await query('DELETE FROM writers_room_folders WHERE id = $1', [folderId]);
    await query('DELETE FROM pipeline_issues WHERE id = $1', [issueId]);
    await runDbMigrations();
  }
  await close();
  if (dest) await rm(dest, { recursive: true, force: true });
});

describe.skipIf(!ready)('restore older database schema', () => {
  it('repairs cached schema readiness and migrates the restored ledger while preserving rows', async () => {
    await ensureSchema({ force: true });
    await runDbMigrations();
    const appliedBefore = await query('SELECT id, applied_at FROM schema_migrations WHERE id <> $1 ORDER BY id', [pendingMigration]);
    await query('DELETE FROM schema_migrations WHERE id = $1', [pendingMigration]);
    const folder = { id: folderId, name: 'Recovered folder' };
    await query('INSERT INTO writers_room_folders (id, name, data) VALUES ($1, $2, $3)', [folderId, folder.name, folder]);
    await query("INSERT INTO pipeline_issues (id, series_id, data) VALUES ($1, 'restore-schema-series', $2)", [
      issueId, { stages: { storyboards: { scenes: [{ description: 'Synthetic scene' }] } } },
    ]);
    await query('ALTER TABLE writers_room_folders DROP COLUMN deleted, DROP COLUMN deleted_at');

    dest = await mkdtemp(join(tmpdir(), 'portos-restore-schema-'));
    const snapshotDir = join(dest, 'snapshots', 'fixture-source', 'old-schema');
    await mkdir(snapshotDir, { recursive: true });
    execFileSync('pg_dump', [
      '--no-owner', '--no-acl', '--clean', '--if-exists',
      '-h', POOL_CONFIG.host, '-p', String(POOL_CONFIG.port),
      '-U', POOL_CONFIG.user, '-d', POOL_CONFIG.database,
      '--table=writers_room_folders', '--table=schema_migrations', '--table=pipeline_issues',
      '-f', join(snapshotDir, 'portos-db.sql'),
    ], { env: { ...process.env, PGPASSWORD: POOL_CONFIG.password } });

    // The running version has cached successful readiness before restore.
    await ensureSchema({ force: true });
    await runDbMigrations();
    await query('UPDATE writers_room_folders SET data = $2 WHERE id = $1', [folderId, { id: folderId, name: 'After backup' }]);
    const result = await restorePostgres(dest, 'old-schema', { source: 'fixture-source', dryRun: false });
    expect(result).toMatchObject({ status: 'ok', dryRun: false });
    expect(await listFolders()).toContainEqual(folder);
    const issue = await query('SELECT data FROM pipeline_issues WHERE id = $1', [issueId]);
    expect(issue.rows[0].data.stages.storyboards.scenes[0].id).toBeTruthy();
    const retained = await query('SELECT id, applied_at FROM schema_migrations WHERE id <> $1 ORDER BY id', [pendingMigration]);
    expect(retained.rows).toEqual(appliedBefore.rows);
    expect(await runDbMigrations()).toBe(0);
  });
});
