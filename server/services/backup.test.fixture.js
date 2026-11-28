/**
 * Shared fixture for the backup service suites (backup.*.test.js): the module
 * mocks, the temp install root, the fake child process and the polling and dump
 * helpers. Not a test file itself: importing it registers the mocks and the
 * file-level hooks, so each suite imports it before anything else.
 *
 * The suites are split by concern so Vitest runs them in parallel workers
 * (#16215); a new backup test goes in the file whose concern it pins. Most of
 * each test's cost is the real durable I/O of the admission journals it
 * exercises (fsync), which is the contract, so it is left real.
 */
import { it as vitestIt, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join as joinPath } from 'path';
import { makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { registerManagedVisitorCredentialRestore } from './bootHookRegistry.js';

// Backup restore tests run without full server bootstrap; preserve the same
// serialized credential-write boundary while keeping the broker lazy.
registerManagedVisitorCredentialRestore(createFileWriteQueue());

// Fail-fast/timeout settles Vitest's wrapper before its async body. These
// real-rsync cases also seed the source between restores; own the whole body
// so neither source nor install cleanup can run underneath that continuation.
const authorityBodies = ownTestBodies(vitestIt);

// runBackup persists state to PATHS.data/backup/state.json. Re-root PATHS at
// a temp tree so the suite can never write into the live install's data dir.
// PATHS.data is <install>/data, as in production: a restore runs frozen file
// migrations, which take the install root and join `data/` themselves.
var TEST_DATA_ROOT;
function testDataRoot() {
  if (!TEST_DATA_ROOT) {
    TEST_DATA_ROOT = joinPath(mkdtempSync(joinPath(tmpdir(), 'portos-backup-install-')), 'data');
    mkdirSync(TEST_DATA_ROOT);
  }
  return TEST_DATA_ROOT;
}
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  // dataPath is overridden too: instanceIdentity.js resolves instances.json
  // through it, and the restore identity tests read that file (#12596).
  return makePathsProxy(actual, { dataRoot: testDataRoot, overrides: {
    atomicWrite: vi.fn(actual.atomicWrite),
    execFileAsync: vi.fn(actual.execFileAsync),
    dataPath: (...segments) => joinPath(testDataRoot(), ...segments),
  } });
});

afterAll(async () => {
  try { await authorityBodies.drain(); }
  finally { if (TEST_DATA_ROOT) rmSync(dirname(TEST_DATA_ROOT), { recursive: true, force: true }); }
});

// Mock the DB health check and child_process.spawn before importing backup.js
const poolConfig = vi.hoisted(() => Object.freeze({ host: 'db.example.test', port: 5439, database: 'example_db', user: 'example_user', password: 'example-secret', ssl: false, sslnegotiation: 'postgres' }));
// The restore recovery journal (#9725) is the real one, rooted in the temp data
// tree, so the suite exercises its durable publication and fence.
vi.mock('../lib/db.js', async () => ({
  POOL_CONFIG: poolConfig,
  checkHealth: vi.fn(),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withDatabaseMaintenance: vi.fn(fn => fn({ adoptRestoreRecovery: vi.fn() })),
  databaseRestoreRecovery: (await vi.importActual('../lib/databaseRestoreRecovery.js')).createDatabaseRestoreRecovery(testDataRoot()),
  ensureSchema: vi.fn().mockResolvedValue(undefined),
  // Default to null (version unknown) so dumpPostgres keeps the bare-`pg_dump`
  // path and the existing status tests don't trigger live binary discovery.
  getServerMajorVersion: vi.fn(() => null),
}));

// The real journal reads the install's data root, never this suite's temp tree.
const maintenanceFence = vi.hoisted(() => ({ fenced: false }));
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({
  assertDatabaseAdmission: () => {
    if (maintenanceFence.fenced) throw Object.assign(new Error('Persistent database maintenance is active'), { status: 503, code: 'DATABASE_MAINTENANCE' });
  },
}));

vi.mock('../scripts/run-db-migrations.js', () => ({
  runDbMigrations: vi.fn().mockResolvedValue(0),
}));
// The file-migration runner a pre-split restore replays through (#12813);
// backupLegacyStores.test.js runs the real one against the real migrations.
const runFileMigrations = vi.hoisted(() => vi.fn());
vi.mock('../../scripts/run-migrations.js', () => ({ runMigrations: runFileMigrations }));
const catalogRepair = vi.hoisted(() => ({
  migrate: vi.fn().mockResolvedValue({ skipped: false }),
  tags: vi.fn().mockResolvedValue({ skipped: false }),
}));
vi.mock('../scripts/migrateCatalogPayload.js', () => ({ migrateCatalogPayload: catalogRepair.migrate }));
vi.mock('../scripts/repairUniverseTags.js', () => ({ repairUniverseTags: catalogRepair.tags }));
const reconcileMediaAssets = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock('./mediaAssetIndex/db.js', () => ({ reconcileMediaAssets }));
const clearRestoredMediaTombstones = vi.hoisted(() => vi.fn().mockResolvedValue({ videos: [], images: [] }));
vi.mock('./mediaRestoreTombstones.js', () => ({ clearRestoredMediaTombstones }));
const executionRestore = vi.hoisted(() => ({ prepare: vi.fn(), finish: vi.fn() }));
vi.mock('./peerExecutionRestore.js', () => ({
  preparePeerExecutionRestore: executionRestore.prepare,
  finishPeerExecutionRestore: executionRestore.finish,
}));
// Passthrough seam: the snapshot-cut failure tests wrap acquisition to shorten the
// drain timeout or fail release. Left unset, runBackup uses the real boundary.
const snapshotCutSeam = vi.hoisted(() => ({ wrap: null }));
vi.mock('../lib/backupSnapshotBoundary.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireBackupSnapshotCut: (...args) => snapshotCutSeam.wrap
      ? snapshotCutSeam.wrap(actual.acquireBackupSnapshotCut, ...args)
      : actual.acquireBackupSnapshotCut(...args),
  };
});
vi.mock('./backupDatabaseReset.js', () => ({
  getDatabaseResetPlan: async () => ({ preflight: 'SELECT 1', reset: 'RESET_APPROVED_SCHEMA' }),
}));
// restorePostgres lazily imports the orchestrator to rewind peer cursors (#8710).
const rewindPostgresSyncCursors = vi.hoisted(() => vi.fn().mockResolvedValue(2));
vi.mock('./syncCursors.js', () => ({
  rewindPostgresSyncCursors,
}));

// Mock the memory-backend resolver so dumpPostgres can tell whether Postgres is
// the ACTIVE backend (explicit or auto-detected) when the DB is unreachable.
vi.mock('./memoryBackend.js', () => ({
  getBackendName: vi.fn(() => null),
  getBrainMemoryLinks: async legacyMap => legacyMap,
}));

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { PassThrough, Readable } from 'node:stream';
import { spawn } from '../lib/childProcess.js';
// Partial mock: only override spawn. Preserve execFile et al. because
// backup.js transitively imports fileUtils.js, which promisifies execFile.
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));

// Mock fs/promises so stat/readFile are spyable in ESM (the real namespace
// is non-configurable). Spread the original first so every other fs helper
// used by backup.js + fileUtils.js keeps its real implementation.
// createReadStream is spyable for the streamed database-dump admission
// (#8782); every other caller keeps the real implementation.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
    access: vi.fn(actual.access),
    unlink: vi.fn(actual.unlink),
    writeFile: vi.fn(actual.writeFile),
  };
});

import { PATHS } from '../lib/fileUtils.js';
import * as fs from 'fs/promises';
// Partial mock of the settings service: only reloadSettings is overridden, so a
// live restore can be asserted to re-sync the settings caches without actually
// touching the developer's settings.json or emitting socket events.
vi.mock('./settings.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reloadSettings: vi.fn(async () => {}),
    withLiveSettingsRestore: vi.fn(actual.withLiveSettingsRestore),
  };
});
vi.mock('./brainStorage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invalidateAllCaches: vi.fn(),
}));
import { DEFAULT_EXCLUDES, restoreSnapshot } from './backup.js';

// fs.access is mocked file-wide because backup.js probes the .in-progress marker
// with it. Restore the real implementation before EVERY test: vi.clearAllMocks()
// resets call history but NOT implementations, so a single test's
// mockResolvedValue would otherwise make every later test see a marker and 409.
beforeEach(async () => {
  await authorityBodies.drain();
  const actual = await vi.importActual('fs/promises');
  fs.readdir.mockImplementation(actual.readdir);
  fs.rename.mockImplementation(actual.rename);
  fs.access.mockImplementation(actual.access);
  fs.readFile.mockImplementation(actual.readFile);
  fs.unlink.mockImplementation(actual.unlink);
  fs.writeFile.mockImplementation(actual.writeFile);
});

// Mirrors backup.js's MACHINE_HOST derivation so expected paths can be built
// without hardcoding this machine's hostname.
const machineHost = hostname().toLowerCase().replace(/[^\w.-]/g, '_') || 'unknown';

// Helper: build a fake child process whose close/error we can drive.
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

// The restore/dump helpers await filesystem and health checks before calling
// spawn() and attaching child-process listeners. Wait for the mocked spawn
// call itself so CI scheduling cannot emit into an uninitialized fake process.
// The explicit timeout covers that real filesystem work on a loaded Windows
// runner, where it has exceeded vi.waitFor's 1s default. The 5 ms interval:
// at the 50 ms default these waits were a fifth of the suite's wall time.
const flush = () => vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: 10_000, interval: 5 });

const overridable = DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path);
const nonOverridable = DEFAULT_EXCLUDES.filter(e => !e.overridable).map(e => e.path);

function assertPoolToolSpawn([, args, { env }]) {
  for (const [flag, key] of [['-h', 'host'], ['-p', 'port'], ['-U', 'user'], ['-d', 'database']]) {
    expect(args[args.indexOf(flag) + 1]).toBe(String(poolConfig[key]));
  }
  expect(env.PGPASSWORD).toBe(poolConfig.password);
  expect(env.PGSSLMODE).toBe('disable');
  expect(env.PGSSLNEGOTIATION).toBe('postgres');
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGHOST', 'PGDATABASE']) expect(env).not.toHaveProperty(key);
  expect(env.PATH).toBe(process.env.PATH);
}

// A complete plain pg_dump envelope as pg_dump 17.6+ writes it. Only the two
// tables every PortOS dump has ever contained — newer tables are optional.
const DUMP_HEADER = '--\n-- PostgreSQL database dump\n--\n\n\\restrict k3y\n\nSET statement_timeout = 0;\n';
const DUMP_TABLES = 'CREATE TABLE public.memories (\n    id uuid NOT NULL\n);\n\nCREATE TABLE public.memory_links (\n    source_id uuid NOT NULL\n);\n\nCOPY public.memories (id) FROM stdin;\n\\.\n\n';
const DUMP_TRAILER = '\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict k3y\n\n';
const COMPLETE_DUMP = DUMP_HEADER + DUMP_TABLES + DUMP_TRAILER;

// Serve the dump bytes from the mocked stream. Each entry answers one read of
// the snapshot dump in order; the last repeats. An Error entry fails that read.
const realFsSync = await vi.importActual('fs');
function mockDumpStream(...reads) {
  const queue = reads.length ? reads : [COMPLETE_DUMP];
  createReadStream.mockImplementation((path, ...rest) => {
    if (!String(path).endsWith('portos-db.sql')) return realFsSync.createReadStream(path, ...rest);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      return new Readable({ read() { this.destroy(next); } });
    }
    return Readable.from([Buffer.from(next)]);
  });
}

// Restore recovery journal + replay-receipt inspection (#9725). By default the
// database reports no live replay session and no receipt, i.e. a failed
// replay is a proven rollback.
const RECOVERY_JOURNAL = () => joinPath(testDataRoot(), 'database-restore-recovery.json');
const readRecoveryJournal = () => (existsSync(RECOVERY_JOURNAL()) ? JSON.parse(readFileSync(RECOVERY_JOURNAL(), 'utf8')) : null);
function restoreDbAnswer({ feed = [], sessions = 0, receipt = null } = {}) {
  return async (sql) => {
    if (sql.includes('pg_stat_activity')) return { rows: [{ sessions, has_receipts: receipt !== null }] };
    if (sql.includes('FROM restore_receipts')) return { rows: receipt ? [{ dump_sha256: receipt }] : [] };
    if (sql.includes('FROM pg_sequences') && !sql.includes('setval')) return { rows: feed };
    return { rows: [] };
  };
}

vi.mock('./cos/cosState.js', () => ({ withLiveCosRestore: vi.fn(fn => fn()) }));
vi.mock('../lib/mediaModels.js', () => ({ withLiveMediaModelsRestore: vi.fn(fn => fn()) }));

const scheduleStoreBoundary = vi.hoisted(() => ({ restore: null }));
vi.mock('./taskScheduleStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  scheduleStoreBoundary.restore = actual.withLiveTaskScheduleRestore;
  return { ...actual, withLiveTaskScheduleRestore: vi.fn(fn => fn()) };
});
// Passthrough spy: health admission and day persistence stay real.
vi.mock('./appleHealthIngest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, withLiveHealthRestore: vi.fn(actual.withLiveHealthRestore) };
});

// The 'restoreSnapshot manifest verification' describe's per-test snapshot
// tree and helpers, shared by the three suites that split it (backup.manifest,
// backup.manifestScope, backup.authority). `bind` receives the fresh paths
// before each test so the suites keep reading them as plain locals.
function useManifestVerification(bind) {
  let tmpRoot;
  let snapshotDir;
  let snapshotDataDir;
  let realFs;
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    realFs = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(realFs.stat);
    fs.readFile.mockImplementation(realFs.readFile);
    fs.access.mockImplementation(realFs.access);
    spawn.mockReset();
    tmpRoot = await realFs.mkdtemp(joinPath(tmpdir(), 'portos-restore-integrity-'));
    snapshotDir = joinPath(tmpRoot, 'snapshots', machineHost, 'snap-1');
    snapshotDataDir = joinPath(snapshotDir, 'data');
    await realFs.mkdir(snapshotDataDir, { recursive: true });
    bind({ tmpRoot, snapshotDir, snapshotDataDir, realFs });
  });

  afterEach(async () => {
    try { await authorityBodies.drain(); }
    finally {
      await realFs?.rm(tmpRoot, { recursive: true, force: true });
      await realFs?.rm(joinPath(PATHS.data, 'restore-integrity'), { recursive: true, force: true });
      await realFs?.rm(joinPath(PATHS.data, 'database-authority.json'), { force: true });
    }
  });

  async function writeSnapshotFile(relativePath, content) {
    const path = joinPath(snapshotDataDir, relativePath);
    await realFs.mkdir(joinPath(path, '..'), { recursive: true });
    await realFs.writeFile(path, content);
    return createHash('sha256').update(Buffer.from(content)).digest('hex');
  }

  async function writeManifest(files) {
    await realFs.writeFile(joinPath(snapshotDir, 'manifest.json'), JSON.stringify({
      generatedAt: '2026-09-12T00:00:00.000Z',
      fileCount: Object.keys(files).length,
      files,
    }));
  }

  async function finishRestore(options = {}) {
    const proc = fakeProc();
    spawn.mockReturnValueOnce(proc);
    const pending = restoreSnapshot(tmpRoot, 'snap-1', options);
    await flush();
    proc.emit('close', 0);
    return pending;
  }

  return { writeSnapshotFile, writeManifest, finishRestore };
}

export {
  authorityBodies,
  testDataRoot,
  poolConfig,
  maintenanceFence,
  runFileMigrations,
  catalogRepair,
  reconcileMediaAssets,
  clearRestoredMediaTombstones,
  executionRestore,
  snapshotCutSeam,
  rewindPostgresSyncCursors,
  machineHost,
  fakeProc,
  flush,
  overridable,
  nonOverridable,
  assertPoolToolSpawn,
  DUMP_HEADER,
  DUMP_TABLES,
  DUMP_TRAILER,
  COMPLETE_DUMP,
  realFsSync,
  mockDumpStream,
  RECOVERY_JOURNAL,
  readRecoveryJournal,
  restoreDbAnswer,
  scheduleStoreBoundary,
  useManifestVerification,
};
