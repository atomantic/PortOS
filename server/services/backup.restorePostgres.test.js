/** Backup service suite: restorePostgres: dump admission, committed-restore recovery and federation resync. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { poolConfig, catalogRepair, reconcileMediaAssets, executionRestore, rewindPostgresSyncCursors, machineHost, fakeProc, flush, assertPoolToolSpawn, DUMP_HEADER, DUMP_TABLES, DUMP_TRAILER, COMPLETE_DUMP, realFsSync, mockDumpStream, RECOVERY_JOURNAL, readRecoveryJournal, restoreDbAnswer } from './backup.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { ensureSchema, query, withDatabaseMaintenance, checkHealth, getServerMajorVersion } from '../lib/db.js';
import { runDbMigrations } from '../scripts/run-db-migrations.js';
import { createHash } from 'crypto';
import { spawn as spawnChild } from 'node:child_process';
import { spawn } from '../lib/childProcess.js';
import { resolve } from 'path';
import * as fs from 'fs/promises';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { execFileAsync } from '../lib/fileUtils.js';
import { posixPath } from '../lib/testHelper.js';

describe('restorePostgres', () => {
  let restorePostgres;
  const mockLegacyDumpRead = (...reads) => {
    vi.spyOn(fs, 'readFile').mockImplementation(async (path) => {
      if (String(path).endsWith('manifest.json')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      throw new Error(`unexpected readFile ${path}`);
    });
    mockDumpStream(...reads);
  };
  afterAll(() => createReadStream.mockImplementation(realFsSync.createReadStream));
  beforeEach(async () => {
    vi.clearAllMocks();
    // listSnapshots installs a persistent readdir spy that returns Dirents.
    // Restore string-returning filesystem reads before Windows ENOENT handling
    // checks for an atomic-write swap sibling.
    const realFs = await vi.importActual('fs/promises');
    if (vi.isMockFunction(fs.readdir)) {
      fs.readdir.mockImplementation((...args) => realFs.readdir(...args));
    }
    // clearAllMocks does not undo stubEnv — a PGPASSWORD stub from a failed
    // (thrown) test would otherwise leak into every test after it.
    vi.unstubAllEnvs();
    vi.stubEnv('PORTOS_PSQL', undefined);
    execFileAsync.mockReset().mockResolvedValue({ stdout: '' });
    rmSync(RECOVERY_JOURNAL(), { force: true });
    query.mockReset().mockImplementation(restoreDbAnswer());
    executionRestore.prepare.mockReset().mockResolvedValue(undefined);
    executionRestore.finish.mockReset().mockResolvedValue(undefined);
    checkHealth.mockResolvedValue({ connected: true });
    getServerMajorVersion.mockResolvedValue(16);
    ({ restorePostgres } = await import('./backup.js'));
  });
  afterEach(async () => {
    // Each case owns this suite's private admission journal. Retained recovery
    // rows are part of individual assertions, not work for the next case.
    for (const operation of maintenance.operations().filter(op => op.kind === 'backup' && op.unsettled)) {
      const recovery = maintenance.recoverOwned('backup', operation.resource);
      recovery.completeRecovery?.();
      await recovery.finish();
    }
  });

  it('refuses a database restore while update maintenance is held', async () => {
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    try {
      await expect(restorePostgres('/dest', 'snap-1', { dryRun: false })).rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
    } finally { maintenance.deferredUpdate.finish(update.id, false); }
  });

  it.each([null, 0, NaN])('refuses an unknown target major %s equally in preview and execution before mutation', async major => {
    getServerMajorVersion.mockResolvedValue(major);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    for (const dryRun of [true, false]) {
      expect(await restorePostgres('/dest', 'snap-1', { dryRun }))
        .toMatchObject({ status: 'failed', reason: 'restore_compatibility', error: expect.stringContaining('SHOW server_version_num') });
    }
    expect(query).not.toHaveBeenCalled();
    expect(withDatabaseMaintenance).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readRecoveryJournal()).toBeNull();
  });

  it('rejects a path-traversal snapshotId', async () => {
    await expect(restorePostgres('/dest', '../../etc', { dryRun: true }))
      .rejects.toThrow(/Invalid snapshotId/);
  });

  it('returns skipped/no_dump when the sql file is absent', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result).toEqual({ status: 'skipped', reason: 'no_dump' });
  });

  it('reports unreadable dump metadata as a restore failure in preview and execution', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('private storage detail'), { code: 'EIO' }));

    for (const dryRun of [true, false]) {
      expect(await restorePostgres('/dest', 'snap-1', { dryRun }))
        .toMatchObject({ status: 'failed', reason: 'dump_unreadable' });
    }

    expect(errorLog).toHaveBeenCalledWith('❌ restore: dump metadata unreadable for snapshot snap-1 (EIO)');
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('private storage detail');
    expect(spawn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(executionRestore.prepare).not.toHaveBeenCalled();
  });

  // portos-db.sql is still being written while a backup runs. Replaying a half
  // dump into the live database is the most destructive thing this module can
  // do, so the guard has to cover it — not just download and file restore.
  it('refuses an incomplete snapshot before reading the dump', async () => {
    fs.access.mockImplementation((path) => String(path).endsWith('.failed')
      ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      : Promise.resolve());                            // .in-progress present
    const statSpy = vi.spyOn(fs, 'stat');

    await expect(restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    expect(statSpy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('dry-run reports size/tableCount without spawning psql', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.dryRun).toBe(true);
    expect(result.sizeBytes).toBe(4096);
    expect(result.tableCount).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(withDatabaseMaintenance).not.toHaveBeenCalled();
    expect(readRecoveryJournal()).toBeNull();
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(runDbMigrations).not.toHaveBeenCalled();
  });

  it('holds the snapshot against deletion while its dump is being admitted, then releases it (#10898)', async () => {
    const snapshotId = '2026-10-09T00-00-00';
    // Same module instance as restorePostgres, whose lease table is module state.
    const { deleteSnapshot } = await import('./backup.js');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true, isDirectory: () => false });
    mockLegacyDumpRead();
    let releaseAdmission;
    getServerMajorVersion.mockImplementationOnce(() => new Promise(resolveMajor => { releaseAdmission = () => resolveMajor(16); }));

    const restoring = restorePostgres('/dest', snapshotId, { dryRun: true });
    await vi.waitFor(() => expect(releaseAdmission).toBeTypeOf('function'));
    // An explicit current-machine source names the same snapshot as the default.
    await expect(deleteSnapshot('/dest', snapshotId, { source: machineHost }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_IN_USE' });

    releaseAdmission();
    await expect(restoring).resolves.toMatchObject({ status: 'ok', dryRun: true });
    // Past the lease, deletion reaches its own existence check.
    await expect(deleteSnapshot('/dest', snapshotId))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('refuses unexpected schema objects before entering maintenance or spawning replay', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    query.mockRejectedValueOnce(Object.assign(
      new Error('Restore preflight: unexpected application-schema relation or owner: rogue_table (owner postgres)'),
      { code: 'P0001' },
    ));
    expect(await restorePostgres('/dest', 'snap-1', { dryRun: false }))
      .toMatchObject({
        status: 'failed',
        reason: 'restore_preflight',
        error: expect.stringContaining('unexpected application-schema relation or owner: rogue_table (owner postgres)'),
      });
    expect(withDatabaseMaintenance).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([true, false])('reports restore_preflight_unavailable on preflight connection failure (dryRun=%s) before maintenance or replay', async (dryRun) => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    query.mockRejectedValueOnce(Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    ));
    expect(await restorePostgres('/dest', 'snap-1', { dryRun }))
      .toMatchObject({
        status: 'failed',
        reason: 'restore_preflight_unavailable',
        error: expect.stringContaining('Restore database connectivity and retry preview before restoring. No data was changed.'),
      });
    expect(withDatabaseMaintenance).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reads a previous-machine dump from the explicitly selected namespace', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();

    await expect(restorePostgres('/dest', 'shared-id', {
      source: 'previous-machine',
      dryRun: true,
    })).resolves.toMatchObject({ status: 'ok', dryRun: true });

    expect(fs.stat).toHaveBeenCalledWith(resolve(
      '/dest', 'snapshots', 'previous-machine', 'shared-id', 'portos-db.sql',
    ));
    expect(fs.readFile).toHaveBeenCalledWith(resolve(
      '/dest', 'snapshots', 'previous-machine', 'shared-id', 'manifest.json',
    ), 'utf-8');
  });

  it('refuses a real restore when PG is not connected', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a real restore while a backup cut is active and releases only its own admission', async () => {
    const { acquireBackupSnapshotCut, withBackupAssetPublication, _backupSnapshotWaitersForTests } = await import('../lib/backupSnapshotBoundary.js');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const releaseBackupCut = await acquireBackupSnapshotCut();
    try {
      expect(await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false }))
        .toMatchObject({ status: 'failed', reason: 'backup_snapshot_busy' });
      expect(withDatabaseMaintenance).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(readRecoveryJournal()).toBeNull();
      // The refused restore never owned the cut: the backup's remains closed.
      let admitted = false;
      const waiting = withBackupAssetPublication(() => { admitted = true; });
      // Parked on the closed cut, so its work cannot have run.
      await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().publications).toBe(1), { interval: 5 });
      expect(admitted).toBe(false);
      releaseBackupCut();
      await waiting;
    } finally {
      releaseBackupCut();
    }
  });

  it('starts a real restore only after an admitted file-plus-row publication drains, then reopens publication', async () => {
    const { withBackupAssetPublication, _backupSnapshotWaitersForTests } = await import('../lib/backupSnapshotBoundary.js');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    let finishRow;
    const halfPublished = withBackupAssetPublication(() => new Promise(resolve => { finishRow = resolve; }));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const restore = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    // The restore's cut is parked draining the half-done publication.
    await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().drains).toBe(1), { interval: 5 });
    expect(withDatabaseMaintenance).not.toHaveBeenCalled();

    finishRow();
    await halfPublished;
    await flush();
    expect(withDatabaseMaintenance).toHaveBeenCalledTimes(1);
    proc.emit('close', 0);
    expect(await restore).toMatchObject({ status: 'ok', dryRun: false });
    await expect(withBackupAssetPublication(() => 'admitted')).resolves.toBe('admitted');
  });

  it('treats a 0-byte dump as no_dump (does not restore a truncated snapshot)', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 0, isFile: () => true });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    expect(result).toEqual({ status: 'skipped', reason: 'no_dump' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('drains verbose psql output so progress cannot stall on pipe backpressure', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    let child;
    spawn.mockImplementationOnce((_bin, _args, options) => {
      // Exercise the restore's actual stdio with output exceeding pipe capacity.
      // The timeout kills a regressed child, so neither it nor the restore hangs.
      child = spawnChild(process.execPath, ['-e',
        "process.stdout.write('COPY 1\\n'.repeat(300000))"
      ], { ...options, timeout: 3000, killSignal: 'SIGKILL' });
      return child;
    });
    try {
      const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
      expect(result).toEqual({ status: 'ok', dryRun: false, sizeBytes: 4096, tableCount: 2, syncCursorsRewound: 2 });
      const [bin, args, opts] = spawn.mock.calls[0];
      expect(bin).toBe('psql');
      expect(args).toEqual(expect.arrayContaining(['-v', 'ON_ERROR_STOP=1', '--single-transaction', '--echo-all', '-f']));
      expect(opts.shell).toBe(false);
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(args.indexOf('-c')).toBeLessThan(args.indexOf('-f'));
      expect(args).toContain('RESET_APPROVED_SCHEMA');
      expect(args).toContain('-X');
      expect(child.stdin).toBeNull();
      expect(child.stdout).not.toBeNull();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('real restore returns failed/restore_error on non-zero psql exit', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.stderr.emit('data', Buffer.from('ERROR: relation already exists'));
    proc.emit('close', 1);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('restore_error');
    expect(result.error).toContain('already exists');
    // Proven rollback (no live replay session, no receipt): admission reopens.
    expect(readRecoveryJournal()).toBeNull();
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(runDbMigrations).not.toHaveBeenCalled();
  });

  it('waits for forced schema repair and then migrations before reporting success', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true });
    let finishSchema;
    let finishMigrations;
    ensureSchema.mockImplementationOnce(() => new Promise(resolve => { finishSchema = resolve; }));
    runDbMigrations.mockImplementationOnce(() => new Promise(resolve => { finishMigrations = resolve; }));
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    let settled = false;
    const pending = restorePostgres('/dest', 'snap-1', { dryRun: false }).then(result => {
      settled = true;
      return result;
    });
    await flush();
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(false);
    proc.emit('close', 0);
    await flush();
    await vi.waitFor(() => expect(ensureSchema).toHaveBeenCalledWith({ force: true }));
    expect(runDbMigrations).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    finishSchema();
    await vi.waitFor(() => expect(runDbMigrations).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishMigrations(0);
    await expect(pending).resolves.toMatchObject({ status: 'ok', dryRun: false });
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    maintenance.deferredUpdate.finish(update.id, false);
  });

  // #9725: a replay that COMMITTED must never reopen ordinary writes, lose its
  // pre-replay feed positions, or be replayed again when repair fails.
  describe('committed-restore recovery', () => {
    const ORIGINAL = [{ sequencename: 'memories_sync_feed_seq', last_value: '500' }];
    const setvalCalls = () => query.mock.calls.filter(([sql]) => sql.includes('setval'));
    let resumeDatabaseRestore;
    beforeEach(async () => {
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
      mockLegacyDumpRead();
      query.mockImplementation(restoreDbAnswer({ feed: ORIGINAL }));
      ({ resumeDatabaseRestore } = await import('./backupRestoreRecovery.js'));
    });

    const runRestore = async ({ exitCode = 0, onSpawn } = {}) => {
      const proc = fakeProc();
      spawn.mockImplementation((...args) => { onSpawn?.(...args); return proc; });
      const pending = restorePostgres('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.emit('close', exitCode);
      return pending;
    };

    it('publishes the operation and ORIGINAL positions before replay and commits a receipt inside the replay', async () => {
      let atSpawn;
      const result = await runRestore({ onSpawn: (_bin, args, opts) => { atSpawn = { args, env: opts.env, journal: readRecoveryJournal() }; } });
      expect(result).toMatchObject({ status: 'ok', syncCursorsRewound: 2 });
      expect(atSpawn.journal).toMatchObject({ stage: 'replaying', snapshotId: 'snap-1', feedPositions: ORIGINAL });
      // The receipt is the LAST command of the single replay transaction.
      expect(atSpawn.args.at(-2)).toBe('-c');
      expect(atSpawn.args.at(-1)).toContain(`INSERT INTO restore_receipts (operation_id, dump_sha256) VALUES ('${atSpawn.journal.id}', '${atSpawn.journal.dumpSha256}')`);
      expect(atSpawn.args.indexOf('-f')).toBeLessThan(atSpawn.args.length - 2);
      expect(atSpawn.env.PGAPPNAME).toBe(`portos-restore-${atSpawn.journal.id}`);
      // Success releases admission.
      expect(readRecoveryJournal()).toBeNull();
      expect(executionRestore.prepare).toHaveBeenCalledWith(atSpawn.journal.id);
      expect(executionRestore.prepare.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
      expect(executionRestore.finish).toHaveBeenCalledWith(atSpawn.journal.id);
    });

    it('never spawns replay when execution recovery capture fails, then recovers the proven unchanged database', async () => {
      executionRestore.prepare.mockRejectedValueOnce(new Error('fixture capture unavailable'));
      const result = await restorePostgres('/dest', 'snap-1', { dryRun: false });
      expect(result).toMatchObject({ status: 'failed', reason: 'restore_execution_reconciliation' });
      expect(spawn).not.toHaveBeenCalled();
      const current = readRecoveryJournal();
      expect(await resumeDatabaseRestore(current.id)).toMatchObject({ status: 'ok', outcome: 'rolled_back' });
      expect(executionRestore.finish).toHaveBeenCalledWith(current.id, { rolledBack: true });
      expect(readRecoveryJournal()).toBeNull();
    });

    it('keeps committed restore fenced through execution reconciliation failure and retries without replay', async () => {
      executionRestore.finish.mockRejectedValueOnce(new Error('fixture execution evidence unavailable'));
      const result = await runRestore();
      expect(result).toMatchObject({ status: 'failed', reason: 'restore_execution_reconciliation' });
      const current = readRecoveryJournal();
      const replayCount = spawn.mock.calls.length;
      expect(await resumeDatabaseRestore(current.id)).toMatchObject({ status: 'ok', outcome: 'repaired' });
      expect(spawn).toHaveBeenCalledTimes(replayCount);
      expect(readRecoveryJournal()).toBeNull();
    });

    it('forces catalog payload migration and universe-tag repair past stale disk markers', async () => {
      catalogRepair.migrate.mockClear();
      catalogRepair.tags.mockClear();
      expect(await runRestore()).toMatchObject({ status: 'ok' });
      expect(catalogRepair.migrate).toHaveBeenCalledWith({ force: true });
      expect(catalogRepair.tags).toHaveBeenCalledWith({ force: true });
    });

    it('retains the generic fence when rollback execution reconciliation fails', async () => {
      executionRestore.finish.mockRejectedValueOnce(new Error('fixture rollback evidence unavailable'));
      const result = await runRestore({ exitCode: 1 });
      expect(result).toMatchObject({ status: 'failed', reason: 'restore_execution_reconciliation' });
      const current = readRecoveryJournal();
      expect(await resumeDatabaseRestore(current.id)).toMatchObject({ status: 'ok', outcome: 'rolled_back' });
      expect(readRecoveryJournal()).toBeNull();
    });

    it.each([
      ['schema upgrade', () => ensureSchema.mockRejectedValueOnce(new Error('ddl failed')), 'restore_schema_reconciliation'],
      ['ordered migration', () => runDbMigrations.mockRejectedValueOnce(new Error('migration failed')), 'restore_schema_reconciliation'],
      ['catalog payload migration', () => catalogRepair.migrate.mockRejectedValueOnce(new Error('payload walk failed')), 'restore_catalog_reconciliation'],
      ['universe tag repair', () => catalogRepair.tags.mockRejectedValueOnce(new Error('tag walk failed')), 'restore_catalog_reconciliation'],
      ['media rebuild', () => reconcileMediaAssets.mockRejectedValueOnce(new Error('media read failed')), 'restore_media_reconciliation'],
      ['cursor write', () => rewindPostgresSyncCursors.mockRejectedValueOnce(new Error('disk full')), 'restore_sync_resync'],
    ])('a %s fault after commit stays fenced, then recovery repairs from the original floors without replaying', async (_case, inject, reason) => {
      inject();
      const failed = await runRestore();
      expect(failed).toMatchObject({ status: 'failed', reason, recovery: { stage: 'repairing', snapshotId: 'snap-1' } });
      expect(failed.error).toMatch(/not .*replayed/i);
      const journal = readRecoveryJournal();
      expect(journal).toMatchObject({ id: failed.recovery.id, stage: 'repairing', feedPositions: ORIGINAL });

      // While pending, neither a preview nor another replay may start.
      for (const dryRun of [true, false]) {
        expect(await restorePostgres('/dest', 'snap-1', { dryRun }))
          .toMatchObject({ status: 'failed', reason: 'restore_recovery_pending', recovery: { id: journal.id } });
      }
      expect(spawn).toHaveBeenCalledOnce();

      // The live sequence was reset to the snapshot's 100 and one draw slipped
      // in; recovery must floor at the recorded 500, never the re-read 101.
      query.mockClear();
      query.mockImplementation(restoreDbAnswer({ feed: [{ sequencename: 'memories_sync_feed_seq', last_value: '101' }] }));
      rewindPostgresSyncCursors.mockClear();
      expect(await resumeDatabaseRestore(journal.id)).toMatchObject({ status: 'ok', outcome: 'repaired', syncCursorsRewound: 2 });
      expect(setvalCalls().map(([, params]) => params)).toEqual([[['memories_sync_feed_seq'], ['500']]]);
      expect(rewindPostgresSyncCursors).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
      expect(readRecoveryJournal()).toBeNull();
      // A finished recovery leaves nothing to resume.
      expect(await resumeDatabaseRestore()).toEqual({ status: 'ok', outcome: 'none' });
    });

    it('refuses to resume a different operation than the pending one', async () => {
      runDbMigrations.mockRejectedValueOnce(new Error('migration failed'));
      await runRestore();
      await expect(resumeDatabaseRestore('00000000-0000-4000-8000-000000000001'))
        .rejects.toMatchObject({ status: 409 });
      expect(readRecoveryJournal()).toMatchObject({ stage: 'repairing' });
    });

    it('resolves a lost psql response at COMMIT from the receipt and repairs instead of replaying', async () => {
      let journal;
      query.mockImplementation(async (sql, params) => restoreDbAnswer({ feed: ORIGINAL, receipt: journal?.dumpSha256 })(sql, params));
      const result = await runRestore({ exitCode: 2, onSpawn: () => { journal = readRecoveryJournal(); } });
      expect(result).toMatchObject({ status: 'ok', syncCursorsRewound: 2 });
      expect(ensureSchema).toHaveBeenCalledWith({ force: true });
      expect(setvalCalls()[0][1]).toEqual([['memories_sync_feed_seq'], ['500']]);
      expect(readRecoveryJournal()).toBeNull();
    });

    it('keeps an unprovable outcome fenced, then releases unchanged once the receipt proves a rollback', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('pg_stat_activity')) throw new Error('connection refused');
        return restoreDbAnswer({ feed: ORIGINAL })(sql);
      });
      const result = await runRestore({ exitCode: 2 });
      expect(result).toMatchObject({ status: 'failed', reason: 'restore_commit_unknown', recovery: { stage: 'replaying' } });
      expect(readRecoveryJournal()).toMatchObject({ stage: 'replaying' });
      expect(ensureSchema).not.toHaveBeenCalled();
      expect(rewindPostgresSyncCursors).not.toHaveBeenCalled();

      query.mockImplementation(restoreDbAnswer());
      expect(await resumeDatabaseRestore(result.recovery.id)).toEqual({ status: 'ok', outcome: 'rolled_back' });
      expect(readRecoveryJournal()).toBeNull();
      expect(spawn).toHaveBeenCalledOnce();
      expect(setvalCalls()).toHaveLength(0);
    });

    it('treats a still-live replay session or a foreign digest as unprovable, and only a matching receipt as a commit', async () => {
      // Seed a pending replay whose outcome was never observed (crash at COMMIT).
      runDbMigrations.mockRejectedValueOnce(new Error('migration failed'));
      await runRestore();
      const pending = readRecoveryJournal();
      writeFileSync(RECOVERY_JOURNAL(), JSON.stringify({ ...pending, stage: 'replaying' }));
      vi.useFakeTimers();
      try {
        query.mockImplementation(restoreDbAnswer({ sessions: 1 }));
        const live = resumeDatabaseRestore(pending.id);
        await vi.runAllTimersAsync();
        expect(await live).toMatchObject({ status: 'failed', reason: 'restore_commit_unknown' });
      } finally {
        vi.useRealTimers();
      }
      query.mockImplementation(restoreDbAnswer({ receipt: 'b'.repeat(64) }));
      expect(await resumeDatabaseRestore(pending.id)).toMatchObject({ reason: 'restore_commit_unknown' });
      expect(readRecoveryJournal()).toMatchObject({ stage: 'replaying' });
      query.mockImplementation(restoreDbAnswer({ feed: ORIGINAL, receipt: pending.dumpSha256 }));
      expect(await resumeDatabaseRestore(pending.id)).toMatchObject({ status: 'ok', outcome: 'repaired' });
      expect(readRecoveryJournal()).toBeNull();
      expect(spawn).toHaveBeenCalledOnce();
    });

    it('fails closed on a damaged journal', async () => {
      writeFileSync(RECOVERY_JOURNAL(), '{ not json');
      expect(await restorePostgres('/dest', 'snap-1', { dryRun: true }))
        .toMatchObject({ status: 'failed', reason: 'restore_recovery_pending', recovery: { damaged: true } });
      await expect(resumeDatabaseRestore()).rejects.toMatchObject({ code: 'DATABASE_RESTORE_RECOVERY' });
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(RECOVERY_JOURNAL(), 'utf8')).toBe('{ not json');
    });
  });

  // #8710: a restore must not leave peers skipping rows in either direction.
  describe('federation resync', () => {
    const setvalCalls = () => query.mock.calls.filter(([sql]) => sql.includes('setval'));
    const captureCalls = () => query.mock.calls.filter(([sql]) => sql.includes('FROM pg_sequences') && !sql.includes('setval'));
    beforeEach(() => {
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
      mockLegacyDumpRead();
      query.mockImplementation(restoreDbAnswer({ feed: [{ sequencename: 'memories_sync_feed_seq', last_value: '1000000000000500' }] }));
    });

    const runRestore = async ({ exitCode = 0 } = {}) => {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restorePostgres('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.emit('close', exitCode);
      return pending;
    };

    it('floors feed sequences at their pre-replay value and rewinds peer cursors after reconciliation', async () => {
      const result = await runRestore();
      expect(result).toEqual({ status: 'ok', dryRun: false, sizeBytes: 4096, tableCount: 2, syncCursorsRewound: 2 });
      // Captured inside maintenance, before psql replays the dump.
      expect(captureCalls()).toHaveLength(1);
      expect(captureCalls()[0][1][0]).toContain('catalog_ingredients_sync_feed_seq');
      expect(query.mock.invocationCallOrder.at(-2)).toBeLessThan(spawn.mock.invocationCallOrder[0]);
      // Floored after schema recovery (which recreates missing sequences).
      expect(setvalCalls()).toHaveLength(1);
      expect(setvalCalls()[0][0]).toContain('GREATEST');
      expect(setvalCalls()[0][1]).toEqual([['memories_sync_feed_seq'], ['1000000000000500']]);
      expect(query.mock.invocationCallOrder.at(-1)).toBeGreaterThan(runDbMigrations.mock.invocationCallOrder[0]);
      expect(rewindPostgresSyncCursors).toHaveBeenCalledOnce();
    });

    it('changes neither sequences nor cursors on dry-run, replay failure, or reconciliation failure', async () => {
      expect(await restorePostgres('/dest', 'snap-1', { dryRun: true })).toMatchObject({ status: 'ok', dryRun: true });
      expect(await runRestore({ exitCode: 1 })).toMatchObject({ status: 'failed', reason: 'restore_error' });
      spawn.mockClear();
      runDbMigrations.mockRejectedValueOnce(new Error('upgrade failed'));
      expect(await runRestore()).toMatchObject({ status: 'failed', reason: 'restore_schema_reconciliation' });
      expect(setvalCalls()).toHaveLength(0);
      expect(rewindPostgresSyncCursors).not.toHaveBeenCalled();
    });

    it('reports an applied dump whose peer resync failed', async () => {
      rewindPostgresSyncCursors.mockRejectedValueOnce(new Error('disk full'));
      const result = await runRestore();
      expect(result).toMatchObject({ status: 'failed', reason: 'restore_sync_resync' });
      expect(result.error).toContain('dump was applied');
    });
  });

  // Dump completeness admission (#8782). Historical snapshots carry no hash, so
  // a truncated-but-parseable dump must be caught from its own envelope before
  // the full reset — ON_ERROR_STOP cannot see a file that simply stops early.
  describe('dump admission', () => {
    beforeEach(() => {
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    });
    const expectRefusedBeforeReset = () => {
      expect(withDatabaseMaintenance).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(rewindPostgresSyncCursors).not.toHaveBeenCalled();
    };

    it.each([
      ['a header-only legacy dump', DUMP_HEADER, /completion marker.*memories.*memory_links/],
      ['a dump truncated between complete statements', DUMP_HEADER + DUMP_TABLES, /completion marker/],
      ['a complete envelope without the core PortOS tables', DUMP_HEADER + DUMP_TRAILER, /table memories, table memory_links/],
      ['content after the completion marker', `${COMPLETE_DUMP}DROP TABLE public.memories;\n`, /completion marker/],
    ])('refuses %s in preview and execution before any reset', async (_case, sql, missing) => {
      mockLegacyDumpRead(sql);
      for (const dryRun of [true, false]) {
        const result = await restorePostgres('/dest', 'snap-1', { dryRun });
        expect(result).toMatchObject({ status: 'failed', reason: 'dump_incomplete' });
        expect(result.error).toMatch(missing);
      }
      expectRefusedBeforeReset();
    });

    it('refuses an unreadable dump instead of treating it as empty', async () => {
      mockLegacyDumpRead(Object.assign(new Error('media I/O failure'), { code: 'EIO' }));
      for (const dryRun of [true, false]) {
        expect(await restorePostgres('/dest', 'snap-1', { dryRun }))
          .toMatchObject({ status: 'failed', reason: 'dump_unreadable' });
      }
      expectRefusedBeforeReset();
    });

    it('admits a complete legacy dump of empty tables written by an older pg_dump', async () => {
      // No \\restrict/\\unrestrict, CRLF-free, empty COPY blocks, no newer tables.
      mockLegacyDumpRead(`--\n-- PostgreSQL database dump\n--\n\n${DUMP_TABLES}--\n-- PostgreSQL database dump complete\n--\n\n`);
      expect(await restorePostgres('/dest', 'snap-1', { dryRun: true }))
        .toEqual({ status: 'ok', dryRun: true, sizeBytes: 4096, tableCount: 2 });
    });

    // A later swap on the backup media must not reach psql: it replays the
    // private copy the admission read wrote, and the copy is removed afterwards.
    it('verifies original integrity and receipts while normalizing extension metadata and the PG17 header', async () => {
      const comment = "COMMENT ON EXTENSION vector IS 'provisioned extension';";
      const extensionDrop = 'DROP EXTENSION IF EXISTS vector;';
      const sql = DUMP_HEADER + 'SET transaction_timeout = 0;\n'
        + extensionDrop + '\n' + comment + '\n' + DUMP_TABLES + DUMP_TRAILER;
      const originalHash = createHash('sha256').update(sql).digest('hex');
      vi.spyOn(fs, 'readFile').mockImplementation(async path => {
        if (String(path).endsWith('manifest.json')) return JSON.stringify({ files: { '../portos-db.sql': originalHash } });
        throw new Error('Unexpected read');
      });
      mockDumpStream(sql);
      const proc = fakeProc();
      let replayed;
      spawn.mockImplementation((_bin, args) => {
        const path = args[args.indexOf('-f') + 1];
        replayed = { path, sql: readFileSync(path, 'utf8') };
        expect(args.at(-1)).toContain(originalHash);
        expect(readRecoveryJournal().dumpSha256).toBe(originalHash);
        return proc;
      });
      const pending = restorePostgres('/dest', 'snap-1', { dryRun: false });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      proc.emit('close', 0);
      expect(await pending).toMatchObject({ status: 'ok', dryRun: false });
      expect(replayed.sql).toBe(sql.replace(comment, '').replace(extensionDrop, '').replace('SET transaction_timeout = 0;\n', ''));
      expect(existsSync(replayed.path)).toBe(false);
    });

    it('replays exactly the admitted bytes from a private spool, never the snapshot path', async () => {
      mockLegacyDumpRead(COMPLETE_DUMP, `${DUMP_HEADER}COMMIT;\n${DUMP_TRAILER}`);
      const proc = fakeProc();
      let replayed;
      spawn.mockImplementation((_bin, args) => {
        const spoolPath = args[args.indexOf('-f') + 1];
        replayed = { spoolPath, sql: readFileSync(spoolPath, 'utf8'), mode: statSync(spoolPath).mode & 0o777 };
        return proc;
      });
      const pending = restorePostgres('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.emit('close', 0);
      expect(await pending).toMatchObject({ status: 'ok', dryRun: false, tableCount: 2 });
      expect(replayed.sql).toBe(COMPLETE_DUMP);
      expect(replayed.spoolPath).not.toContain('snap-1');
      expect(createReadStream.mock.calls.filter(([path]) => String(path).endsWith('portos-db.sql'))).toHaveLength(1);
      if (process.platform !== 'win32') expect(replayed.mode).toBe(0o600);
      expect(existsSync(replayed.spoolPath)).toBe(false);
    });
  });

  // Manifest SHA-256 verification (#980). The dump is hashed in generateManifest
  // under the parent-relative key '../portos-db.sql' — these tests assert the
  // exact key, the mismatch refusal, and the backward-compat skip paths.
  //
  // The dump is hashed from the same stream admission reads (#8782). readFile
  // is mocked path-aware for manifest.json; the dump bytes come from the
  // mocked stream, and their real sha256 is the constant below.
  const DUMP_SQL = COMPLETE_DUMP;
  // Compute the genuine hash so the "match" test verifies real bytes, not a
  // hard-coded string that could drift from sha256File's implementation.
  const REAL_DUMP_SHA256 = createHash('sha256').update(Buffer.from(DUMP_SQL)).digest('hex');

  function mockDumpAndManifest(manifestObj) {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: DUMP_SQL.length, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
      const path = String(p);
      if (path.endsWith('manifest.json')) {
        if (manifestObj === null) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return JSON.stringify(manifestObj);
      }
      throw new Error(`unexpected readFile ${path}`);
    });
    mockDumpStream(DUMP_SQL);
  }

  it('proceeds when the dump hash matches the manifest (match)', async () => {
    mockDumpAndManifest({ files: { '../portos-db.sql': REAL_DUMP_SHA256 } });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.dryRun).toBe(true);
    expect(result.tableCount).toBe(2);
  });

  it('refuses with manifest_mismatch when the dump hash differs (mismatch)', async () => {
    mockDumpAndManifest({ files: { '../portos-db.sql': 'deadbeef'.repeat(8) } });
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    expect(result).toEqual({ status: 'failed', reason: 'manifest_mismatch' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips verification when manifest.json is absent (backward-compat)', async () => {
    mockDumpAndManifest(null);
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.tableCount).toBe(2);
  });

  it('skips verification when the manifest lacks the dump key (pre-#976 manifest)', async () => {
    mockDumpAndManifest({ files: { 'instances.json': 'abc123' } });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.tableCount).toBe(2);
  });

  it.each([
    ['malformed JSON', '{ "files": { '],
    ['a non-ENOENT read failure', Object.assign(new Error('media I/O failure'), { code: 'EIO' })],
  ])('refuses dry-run and real restore when manifest.json has %s', async (_case, manifestResult) => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: DUMP_SQL.length, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
      if (!String(p).endsWith('manifest.json')) throw new Error(`unexpected readFile ${p}`);
      if (manifestResult instanceof Error) throw manifestResult;
      return manifestResult;
    });
    mockDumpStream(DUMP_SQL);
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });

    await expect(restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true }))
      .resolves.toEqual({ status: 'failed', reason: 'manifest_unreadable' });
    await expect(restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false }))
      .resolves.toEqual({ status: 'failed', reason: 'manifest_unreadable' });
    expect(checkHealth).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  // psql missing from the host (ENOENT) surfaces as a spawn 'error' event, not a
  // 'close'. Without the error listener the promise would never settle and the
  // restore UI would hang forever — assert it resolves as a structured failure.
  it('resolves failed/restore_error when the psql spawn emits an error event', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('error', new Error('spawn psql ENOENT'));
    await expect(p).resolves.toEqual({
      status: 'failed',
      reason: 'restore_error',
      error: 'spawn psql ENOENT'
    });
  });

  it('kills a silent psql restore after the idle deadline and reports timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
      mockLegacyDumpRead();
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      const proc = fakeProc();
      spawn.mockReturnValue(proc);

      const pending = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
      await flush();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null, 'SIGTERM');
      await expect(pending).resolves.toMatchObject({
        status: 'failed',
        reason: 'timeout',
        error: expect.stringMatching(/10 minutes without progress/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a long psql restore alive while drained stdout reports progress', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
      mockLegacyDumpRead();
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      const proc = fakeProc();
      spawn.mockReturnValue(proc);

      const pending = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
      await flush();
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      proc.stdout.emit('data', Buffer.from('COPY 200000\n'));
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

      expect(proc.kill).not.toHaveBeenCalled();
    proc.emit('close', 0);
      await expect(pending).resolves.toMatchObject({ status: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['PORTOS_PSQL override', '/custom/bin/psql', '', '/custom/bin/psql'],
    ['keg-only client', undefined, '', '/opt/homebrew/opt/postgresql@17/bin/psql'],
    ['older PATH client', undefined, 'psql (PostgreSQL) 16.12', '/opt/homebrew/opt/postgresql@17/bin/psql'],
  ])('spawns the resolved psql with a %s', async (_case, override, pathOutput, expectedBinary) => {
    const homebrew = '/opt/homebrew/opt';
    const kegBinary = `${homebrew}/postgresql@17/bin/psql`;
    const readDir = fs.readdir.getMockImplementation();
    fs.readdir.mockImplementation(async (path, ...args) => {
      if (path === homebrew) return ['postgresql@17'];
      if (path === '/usr/local/opt' || path === '/Applications/Postgres.app/Contents/Versions') return [];
      return readDir(path, ...args);
    });
    execFileAsync.mockImplementation(async binary => ({
      stdout: binary === 'psql' ? pathOutput : posixPath(binary) === kegBinary ? 'psql (PostgreSQL) 17.12' : '',
    }));
    vi.stubEnv('PORTOS_PSQL', override);
    getServerMajorVersion.mockResolvedValue(17);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restorePostgres('/dest', 'snap-1', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    expect(await pending).toMatchObject({ status: 'ok', dryRun: false });
    expect(posixPath(spawn.mock.calls[0][0])).toBe(expectedBinary);
  });

  // The atomicity contract: ON_ERROR_STOP=1 aborts on the first failed statement
  // and --single-transaction rolls the whole replay back, so a failed restore
  // leaves the live DB untouched instead of half-dropped. Both flags are load
  // bearing — a refactor that drops either turns a failed restore into data loss.
  it('passes atomic replay flags with the captured pool credentials', async () => {
    vi.stubEnv('PGPASSWORD', '');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    await p;
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('psql');
    expect(args).toContain('--single-transaction');
    // Assert the flag/value pairing, not just membership: '-v' followed by
    // something else would still satisfy arrayContaining.
    expect(args[args.indexOf('-v') + 1]).toBe('ON_ERROR_STOP=1');
    expect(opts.env.PGPASSWORD).toBe(poolConfig.password);
  });

  it('ignores changed endpoint, password and inherited libpq policy during restore', async () => {
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE']) vi.stubEnv(key, 'poisoned');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    mockLegacyDumpRead();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    await p;
    assertPoolToolSpawn(spawn.mock.calls[0]);
  });
});
