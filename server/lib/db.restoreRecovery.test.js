// Database admission while a committed snapshot restore awaits recovery (#9725).
// The journal is the real one, in a temp data root; pg is a stub pool, so no
// statement can reach a real database even if admission regressed.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = vi.hoisted(() => ({ dataRoot: null }));
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

const begin = () => databaseRestoreRecovery.begin({
  snapshotId: 'snap-1', dumpSha256: 'a'.repeat(64),
  feedPositions: [{ sequencename: 'memories_sync_feed_seq', last_value: '500' }],
});
const FENCED = { status: 503, code: 'DATABASE_RESTORE_RECOVERY' };

beforeEach(() => {
  rmSync(databaseRestoreRecovery.path, { force: true });
  vi.clearAllMocks();
});
afterAll(() => rmSync(fixture.dataRoot, { recursive: true, force: true }));

describe('restore recovery admission', () => {
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
