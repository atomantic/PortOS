// Database admission while a committed snapshot restore awaits recovery (#9725).
// The journal is the real one, in a temp data root; pg is a stub pool, so no
// statement can reach a real database even if admission regressed.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = vi.hoisted(() => ({ dataRoot: null, releaseFault: null, executionFault: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    unlinkSync: vi.fn((path) => {
      if (fixture.releaseFault === 'unlink' && path === join(fixture.dataRoot, 'database-restore-recovery.json')) {
        throw Object.assign(new Error('synthetic unlink failure'), { code: 'EIO' });
      }
      return fs.unlinkSync(path);
    }),
    fsyncSync: vi.fn((fd) => {
      if (fixture.releaseFault === 'directory-sync' && fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    }),
  };
});
vi.mock('./db.js', async (importOriginal) => ({
  ...await importOriginal(),
  ensureSchema: vi.fn(async () => {}),
}));
vi.mock('../scripts/run-db-migrations.js', () => ({
  runDbMigrations: vi.fn(async () => 0),
}));
vi.mock('../services/syncOrchestrator.js', () => ({
  rewindPostgresSyncCursors: vi.fn(async () => 2),
}));
// This suite isolates generic DB admission/release with a statement-free pg
// pool. Real execution-ledger SQL/capture/retry lives in the two DB fixtures.
vi.mock('../services/peerExecutionRestore.js', () => ({
  finishPeerExecutionRestore: vi.fn(async () => {
    if (fixture.executionFault) throw Object.assign(new Error('synthetic execution reconciliation failure'), {
      code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE', status: 503,
    });
    return { phase: 'ready' };
  }),
}));
vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync: mkdtemp } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  fixture.dataRoot = mkdtemp(joinPath(tmp(), 'portos-restore-admission-'));
  return { ...actual, PATHS: { ...actual.PATHS, data: fixture.dataRoot } };
});

const pool = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  on: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('pg', async (importOriginal) => ({
  default: {
    Client: (await importOriginal()).default.Client,
    Pool: vi.fn(function Pool() { return pool; }),
    types: { setTypeParser: vi.fn() },
  },
}));

const { query, withTransaction, withDatabaseMaintenance, databaseRestoreRecovery } = await import('./db.js');

const { resumeDatabaseRestore, getDatabaseRestoreRecoveryStatus } = await import('../services/backupRestoreRecovery.js');

const begin = () => databaseRestoreRecovery.begin({
  snapshotId: 'snap-1', dumpSha256: 'a'.repeat(64),
  feedPositions: [{ sequencename: 'memories_sync_feed_seq', last_value: '500' }],
});
const FENCED = { status: 503, code: 'DATABASE_RESTORE_RECOVERY' };

beforeEach(() => {
  rmSync(databaseRestoreRecovery.path, { force: true });
  fixture.executionFault = false;
  vi.clearAllMocks();
});
afterAll(() => rmSync(fixture.dataRoot, { recursive: true, force: true }));

describe('restore recovery admission', () => {
  it('retains generic admission when execution reconciliation fails and releases only after same-ID retry succeeds', async () => {
    const record = databaseRestoreRecovery.markCommitted(begin().id);
    fixture.executionFault = true;
    expect(await resumeDatabaseRestore(record.id)).toMatchObject({ status: 'failed', reason: 'restore_execution_reconciliation', recovery: { id: record.id } });
    expect(databaseRestoreRecovery.read()).toEqual(record);
    await expect(query('SELECT ordinary')).rejects.toMatchObject(FENCED);
    const { rewindPostgresSyncCursors } = await import('../services/syncOrchestrator.js');
    expect(rewindPostgresSyncCursors).not.toHaveBeenCalled();
    fixture.executionFault = false;
    expect(await resumeDatabaseRestore(record.id)).toMatchObject({ status: 'ok', outcome: 'repaired' });
    expect(getDatabaseRestoreRecoveryStatus()).toEqual({ pending: false });
    await expect(query('SELECT ordinary')).resolves.toEqual({ rows: [] });
  });
  it('keeps ordinary work fenced after the restore that adopted the operation returns', async () => {
    let id;
    await withDatabaseMaintenance(async ({ adoptRestoreRecovery }) => {
      id = begin().id;
      adoptRestoreRecovery(id);
      // The owning operation keeps the database for itself, including nested work.
      await query('SELECT 1');
      await withTransaction(client => client.query('SELECT 2'));
      // A committed replay whose repair failed returns with the journal in place.
    });
    await expect(query('SELECT 3')).rejects.toMatchObject(FENCED);
    await expect(withTransaction(() => {})).rejects.toMatchObject(FENCED);
    await expect(withDatabaseMaintenance(() => {})).rejects.toMatchObject(FENCED);
    expect(pool.query.mock.calls.map(([sql]) => sql)).toEqual(['SELECT 1']);

    // Only the matching operation may re-enter; release reopens admission.
    await expect(withDatabaseMaintenance(() => {}, { restoreRecoveryId: '00000000-0000-4000-8000-000000000009' }))
      .rejects.toMatchObject(FENCED);
    await withDatabaseMaintenance(async () => {
      await query('SELECT 4');
      databaseRestoreRecovery.release(id);
    }, { restoreRecoveryId: id });
    await expect(query('SELECT 5')).resolves.toEqual({ rows: [] });
  });

  it.each([null, 'unlink', ...(process.platform === 'win32' ? [] : ['directory-sync'])])('keeps release completion and recovery admission consistent (%s)', async (fault) => {
    const record = databaseRestoreRecovery.markCommitted(begin().id);
    fixture.releaseFault = fault;
    try {
      const result = await resumeDatabaseRestore(record.id);
      if (fault) {
        expect(result).toMatchObject({ status: 'failed', reason: 'restore_recovery_release', recovery: { id: record.id } });
        // Post-unlink failure really has no file: record and fence must survive
        // in the journal instance until directory sync completes.
        expect(existsSync(databaseRestoreRecovery.path)).toBe(fault === 'unlink');
        expect(databaseRestoreRecovery.read()).toEqual(record);
        expect(getDatabaseRestoreRecoveryStatus()).toMatchObject({ pending: true, id: record.id, stage: 'repairing' });
        await expect(query('SELECT ordinary')).rejects.toMatchObject(FENCED);
        await expect(withTransaction(() => {})).rejects.toMatchObject(FENCED);
        await expect(resumeDatabaseRestore('00000000-0000-4000-8000-000000000009'))
          .rejects.toMatchObject({ code: 'RESTORE_RECOVERY_MISMATCH' });
        expect(() => databaseRestoreRecovery.release('00000000-0000-4000-8000-000000000009')).toThrow();
        expect(() => begin()).toThrow();
        expect(databaseRestoreRecovery.read()).toEqual(record);
        fixture.releaseFault = null;
        await expect(resumeDatabaseRestore(record.id)).resolves.toMatchObject({ status: 'ok', outcome: 'repaired' });
      } else {
        expect(result).toMatchObject({ status: 'ok', outcome: 'repaired' });
      }
      expect(existsSync(databaseRestoreRecovery.path)).toBe(false);
      expect(getDatabaseRestoreRecoveryStatus()).toEqual({ pending: false });
      await expect(query('SELECT ordinary')).resolves.toEqual({ rows: [] });
      await expect(withTransaction(client => client.query('SELECT ordinary'))).resolves.toEqual({ rows: [] });
      const queriesBeforeRetry = pool.query.mock.calls.length;
      await expect(resumeDatabaseRestore(record.id)).resolves.toEqual({ status: 'ok', outcome: 'none' });
      expect(pool.query).toHaveBeenCalledTimes(queriesBeforeRetry);
      // Recovery only floors original positions; no reset, replay or receipt inspection.
      expect(pool.query.mock.calls).toEqual([
        ...Array.from({ length: fault ? 2 : 1 }, () => [
          expect.stringContaining('SELECT setval'),
          [record.feedPositions.map(p => p.sequencename), record.feedPositions.map(p => p.last_value)],
        ]),
        ['SELECT ordinary', undefined],
      ]);
    } finally {
      fixture.releaseFault = null;
      if (databaseRestoreRecovery.isFenced()) databaseRestoreRecovery.release(record.id);
    }
  });

  it('withdraws recovery authority from work that outlives the maintenance context', async () => {
    const { id } = begin();
    let escape;
    await withDatabaseMaintenance(async () => {
      escape = () => query('SELECT late');
    }, { restoreRecoveryId: id });
    await expect(escape()).rejects.toMatchObject(FENCED);
  });

  it('fails closed on a damaged journal, including the boot fence', async () => {
    writeFileSync(databaseRestoreRecovery.path, '{"version":1');
    await expect(query('SELECT 1')).rejects.toMatchObject(FENCED);
    expect(() => databaseRestoreRecovery.read()).toThrow();
    await expect(import('../services/databaseBootFence.js')).rejects.toMatchObject({ code: 'DATABASE_RESTORE_RECOVERY' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('never lets a second restore overwrite a pending operation', () => {
    const first = begin();
    expect(() => begin()).toThrow();
    expect(databaseRestoreRecovery.read()).toEqual(first);
    expect(databaseRestoreRecovery.markCommitted(first.id)).toEqual({ ...first, stage: 'repairing' });
    expect(databaseRestoreRecovery.read().feedPositions).toEqual(first.feedPositions);
  });
});

// A restarted server with recovery pending must not reach its application
// graph: start.js resumes recovery first and refuses boot unless it completes.
describe('restart with pending restore recovery', () => {
  const startScript = fileURLToPath(new URL('../start.js', import.meta.url));
  const childEnv = { ...process.env };
  delete childEnv.VITEST;

  const boot = (journalBody) => {
    const root = mkdtempSync(join(tmpdir(), 'portos-restore-boot-'));
    try {
      writeFileSync(join(root, '.portos-disposable-root'), '');
      mkdirSync(join(root, 'data'));
      const journalPath = join(root, 'data', 'database-restore-recovery.json');
      writeFileSync(journalPath, journalBody);
      // No real pg connection is possible: every pool use throws.
      const stub = `export default {Client:class {connectionParameters={ssl:false,sslnegotiation:"postgres"}},types:{setTypeParser(){}},Pool:class {
        on(){} query(){throw Error('POOL_REACHED')} connect(){throw Error('POOL_REACHED')}
      }};`;
      const loader = join(root, 'pg-loader.mjs');
      writeFileSync(loader, `export async function resolve(specifier, context, next) {
        if (specifier === 'pg') return {url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit:true};
        return next(specifier, context);
      }`);
      const result = spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, startScript], {
        encoding: 'utf8',
        env: { ...childEnv, PORTOS_DATA_ROOT: root, PGDATABASE: 'example_test', PGPASSWORD: 'example-only' },
        timeout: 20_000,
      });
      return { ...result, journalAfter: readFileSync(journalPath, 'utf8') };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('refuses boot and keeps the committed operation when repair cannot finish', () => {
    const record = {
      version: 1, id: '00000000-0000-4000-8000-000000000003', stage: 'repairing',
      createdAt: '2026-01-01T00:00:00.000Z', snapshotId: 'snap-1', dumpSha256: 'a'.repeat(64),
      feedPositions: [{ sequencename: 'memories_sync_feed_seq', last_value: '500' }],
    };
    const body = JSON.stringify(record);
    const result = boot(body);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Database restore recovery is still pending (restore_schema_reconciliation)');
    expect(result.journalAfter).toBe(body);
  });

  it('refuses boot on an unreadable journal without touching it', () => {
    const result = boot('{ damaged');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Database restore recovery is still pending (DATABASE_RESTORE_RECOVERY)');
    expect(result.journalAfter).toBe('{ damaged');
  });
});
