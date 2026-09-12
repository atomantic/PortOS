/**
 * Real psql regression for restoring a pre-federation folder schema.
 * Runs only via test:db against a guarded test database, never live records.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { runDbMigrations } from '../scripts/run-db-migrations.js';
import { listFolders } from './writersRoom/db.js';

const health = await checkHealth();
const ready = requireDbOrSkip('services/backup.db.test',
  health.connected && spawnSync('psql', ['--version']).status === 0,
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
    const folder = { id: folderId, name: 'Recovered folder' };
    await query('INSERT INTO writers_room_folders (id, name, data) VALUES ($1, $2, $3)', [folderId, folder.name, folder]);
    await query("INSERT INTO pipeline_issues (id, series_id, data) VALUES ($1, 'restore-schema-series', $2)", [
      issueId, { stages: { storyboards: { scenes: [{ description: 'Synthetic scene' }] } } },
    ]);

    dest = await mkdtemp(join(tmpdir(), 'portos-restore-schema-'));
    const snapshotDir = join(dest, 'snapshots', 'fixture-source', 'old-schema');
    await mkdir(snapshotDir, { recursive: true });
    // Synthetic clean dump from before folder tombstones and migration 007.
    // Avoid requiring pg_dump to match the test server's major version: CI's
    // psql client can replay this SQL across versions, unlike an older pg_dump.
    const ledgerRows = appliedBefore.rows.map(row =>
      `('${row.id.replaceAll("'", "''")}', '${row.applied_at.toISOString()}')`,
    ).join(', ');
    await writeFile(join(snapshotDir, 'portos-db.sql'), `
      DROP TABLE IF EXISTS writers_room_folders;
      CREATE TABLE writers_room_folders (
        id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0, data JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO writers_room_folders (id, name, data)
        VALUES ('${folderId}', 'Recovered folder', '${JSON.stringify(folder)}');
      DROP TABLE IF EXISTS schema_migrations;
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO schema_migrations (id, applied_at) VALUES ${ledgerRows};
    `);

    // Readiness and the migration ledger both reflect the current version.
    // Replay must replace the ledger and rerun 007 against the synthetic issue.
    await query('UPDATE writers_room_folders SET data = $2 WHERE id = $1', [folderId, { id: folderId, name: 'After backup' }]);
    const { restorePostgres } = await import('./backup.js');
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
