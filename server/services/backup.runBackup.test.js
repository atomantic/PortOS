/** Backup service suite: runBackup lifecycle, snapshot cut failures and retention pruning. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { maintenanceFence, snapshotCutSeam, machineHost, fakeProc, DUMP_HEADER, DUMP_TABLES, DUMP_TRAILER, COMPLETE_DUMP } from './backup.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { rmSync } from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'os';
import { basename, dirname, join as joinPath } from 'path';
import { spawn } from '../lib/childProcess.js';
import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { getBackendName } from './memoryBackend.js';
import * as fs from 'fs/promises';
import { restoreSnapshot } from './backup.js';

// =============================================================================
// runBackup lifecycle (#3915)
//
// runBackup was previously only covered indirectly (backupStatusForPg) or
// mocked out wholesale by the route/scheduler suites. These tests drive the
// real function against a temp destination with rsync + pg_dump stubbed at the
// spawn boundary, and assert only observable effects: what was spawned, what
// landed on disk, what was emitted, and what the module lock did.
//
// Postgres is never touched — checkHealth is mocked unreachable and
// MEMORY_BACKEND=file selects dumpPostgres's explicit file escape hatch, so it
// returns skipped/not_configured without spawning pg_dump.
// =============================================================================
describe('runBackup lifecycle', () => {
  const SKIPPED_PG = { status: 'skipped', reason: 'not_configured' };
  let realFs;
  let destRoot;
  let prevMemoryBackend;
  let runBackup;
  let isBackupInProgress;
  let dataRoot;

  // Real fs bound once, bypassing the module-level fs/promises mock, so the
  // helpers below read what actually landed on disk.
  const actualFs = async () => (realFs ??= await vi.importActual('fs/promises'));

  // rsync/pg_dump are stubbed, so backup work completes via real async I/O
  // rather than on a fixed number of microtasks. Poll instead of guessing.
  async function waitFor(predicate, label) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  // Snapshots live under snapshots/<machine-host>/<snapshotId>; the host
  // segment is derived from os.hostname() inside backup.js and is not
  // exported, so discover it from disk rather than recomputing it here.
  async function findSnapshotDir() {
    const fsp = await actualFs();
    const [host] = await fsp.readdir(joinPath(destRoot, 'snapshots'));
    const entries = await fsp.readdir(joinPath(destRoot, 'snapshots', host), { withFileTypes: true });
    const snapshot = entries.find((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    return joinPath(destRoot, 'snapshots', host, snapshot.name);
  }

  async function readJson(path) {
    const fsp = await actualFs();
    return JSON.parse(await fsp.readFile(path, 'utf-8'));
  }

  beforeEach(async () => {
    // Earlier suites leave persistent fs spies and factory-level stat/readFile
    // stubs installed; these tests use the real filesystem.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const fsp = await actualFs();
    fs.stat.mockImplementation(fsp.stat);
    fs.readFile.mockImplementation(fsp.readFile);

    prevMemoryBackend = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'file';
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    getBackendName.mockReturnValue(null);

    destRoot = await fsp.mkdtemp(joinPath(tmpdir(), 'portos-backup-dest-'));

    // Fresh module per test: `isRunning` is module-level state, so the lock
    // tests must not inherit a previous test's value.
    vi.resetModules();
    ({ runBackup, isBackupInProgress } = await import('./backup.js'));
    ({ PATHS: { data: dataRoot } } = await import('../lib/fileUtils.js'));
  });

  // Restore per-test, not in afterAll: beforeEach re-captures the variable, so
  // an afterAll would put back whatever the LAST test saw ('file') rather than
  // the value this suite inherited.
  afterEach(() => {
    if (prevMemoryBackend === undefined) delete process.env.MEMORY_BACKEND;
    else process.env.MEMORY_BACKEND = prevMemoryBackend;
    rmSync(destRoot, { recursive: true, force: true });
  });

  // Unlike restore-only checks, this catches an unusable snapshot being
  // announced and persisted as healthy even though its SQL dump succeeded.
  it.each(['legacy metadata', 'legacy universe config', 'legacy CoS config', 'legacy CoS agents', 'converted', 'file escape hatch'])(
    'reports restore compatibility through the backup response and durable status: %s', async (scenario) => {
      const fsp = await actualFs();
      const { getState, restoreSnapshot } = await import('./backup.js');
      const fileMode = scenario === 'file escape hatch';
      if (!fileMode) delete process.env.MEMORY_BACKEND;
      getBackendName.mockReturnValue(fileMode ? 'file' : 'postgres');
      checkHealth.mockResolvedValue({ connected: !fileMode, hasSchema: !fileMode });
      const io = recordingOperatorIo();
      const oldSnapshot = joinPath(destRoot, 'snapshots', machineHost, '2020-01-01T00-00-00');
      await fsp.mkdir(joinPath(oldSnapshot, 'data'), { recursive: true });
      await fsp.writeFile(joinPath(oldSnapshot, 'manifest.json'), JSON.stringify({
        generatedAt: '2020-01-01T00:00:00.000Z', fileCount: 0, files: {},
      }));
      const rsync = fakeProc();
      const pgDump = fakeProc();
      spawn.mockReturnValueOnce(rsync);
      if (!fileMode) spawn.mockReturnValueOnce(pgDump);
      const pending = runBackup(destRoot, io, { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      const snapshotId = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
      const snapshotDir = joinPath(destRoot, 'snapshots', machineHost, snapshotId);
      const legacy = scenario !== 'converted';
      const scenarioPaths = {
        'legacy universe config': { 'universes/index.json': JSON.stringify({ config: { runs: [] } }) },
        'legacy CoS config': {
          'cos/config.json': JSON.stringify({ userTasksFile: 'data/queues/user.md' }),
          'queues/user.md': '# User Tasks',
        },
        'legacy CoS agents': { 'cos/state.json': JSON.stringify({ agents: {} }) },
      };
      const paths = scenarioPaths[scenario] ?? (legacy ? {
          'universes/universe-example/index.json': '{}',
          'pipeline-issues/iss-example/index.json': '{}',
          'pipeline-series/ser-example/index.json': '{}',
          'story-builder/stb-example/index.json': '{}',
          'writers-room/folders.json': '[]',
          'creative-director-projects.json': '[]',
          'COS-TASKS.md': '# Internal Tasks',
        } : {
          'universes/index.json': '{}',
          'universes.imported/universe-example/index.json': '{}',
          'universes/universe-example/assets/sheet.png': 'synthetic asset',
          'writers-room/folders.imported.json': '[]',
          'TASKS.md.imported': '# User Tasks',
          'cos/state.json': JSON.stringify({ stats: { totalTasks: 1 } }),
        });
      for (const [path, content] of Object.entries(paths)) {
        const target = joinPath(snapshotDir, 'data', path);
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
      }
      rsync.emit('close', 0);
      if (!fileMode) {
        await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
        await fsp.writeFile(joinPath(snapshotDir, 'portos-db.sql'), COMPLETE_DUMP);
        pgDump.emit('close', 0);
      }
      const result = await pending;
      if (process.platform !== 'win32') {
        for (const path of [dirname(snapshotDir), snapshotDir, joinPath(snapshotDir, 'data')]) {
          expect((await fsp.stat(path)).mode & 0o777).toBe(0o700);
        }
        const manifest = joinPath(snapshotDir, 'manifest.json');
        expect((await fsp.stat(manifest)).mode & 0o777).toBe(0o600);
        if (!fileMode) expect((await fsp.stat(joinPath(snapshotDir, 'portos-db.sql'))).mode & 0o777).toBe(0o600);
      }
      const expectedStatus = legacy && !fileMode ? 'degraded' : 'ok';
      expect(result).toMatchObject({ status: expectedStatus, pgBackup: { status: fileMode ? 'skipped' : 'ok' } });
      expect(await getState()).toMatchObject({ status: expectedStatus, restoreWarning: result.restoreWarning, error: result.error });
      expect(io.emit).toHaveBeenCalledWith('backup:completed', expect.objectContaining({ status: expectedStatus, restoreWarning: result.restoreWarning }));
      for (const [path, content] of Object.entries(paths)) {
        expect(await fsp.readFile(joinPath(snapshotDir, 'data', path), 'utf8')).toBe(content);
      }
      if (expectedStatus === 'degraded') {
        const scenarioDomains = {
          'legacy universe config': ['universes'],
          'legacy CoS config': ['cos-tasks'],
          'legacy CoS agents': ['cos-agents'],
        };
        const domains = scenarioDomains[scenario]
          ?? ['universes', 'pipeline-issues', 'pipeline-series', 'story-builder', 'writers-room', 'creative-director', 'cos-tasks'];
        expect(result.prunedSnapshots).toBe(0);
        await expect(fsp.access(oldSnapshot)).resolves.toBeUndefined();
        expect(result.restoreWarning).toMatchObject({ code: 'BACKUP_LEGACY_DB_METADATA', domains });
        expect(result.error).toContain('disposable offline upgrade install');
        expect(result.manifest.files['../portos-db.sql']).toMatch(/^[a-f0-9]{64}$/);
        await expect(restoreSnapshot(destRoot, result.snapshotId, { dryRun: true }))
          .rejects.toMatchObject({ code: result.restoreWarning.code, context: { domains } });
      } else {
        expect(result.restoreWarning).toBeNull();
        const preview = fakeProc();
        spawn.mockReturnValueOnce(preview);
        const spawnCount = spawn.mock.calls.length;
        const restoring = restoreSnapshot(destRoot, result.snapshotId, { dryRun: true });
        await waitFor(() => spawn.mock.calls.length > spawnCount, 'restore preview spawn');
        preview.emit('close', 0);
        await expect(restoring).resolves.toMatchObject({ dryRun: true, verification: { status: 'verified' } });
      }
    },
  );

  it.each(['completed', 'failed', 'interrupted', 'reservation', 'directory race'])('preserves a colliding %s snapshot while a new run fails', async (state) => {
    const fsp = await actualFs();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    try {
      const oldId = '2026-01-02T03-04-05';
      const root = joinPath(destRoot, 'snapshots', machineHost);
      const oldDir = joinPath(root, oldId);
      const guard = joinPath(root, `.${oldId}.in-progress`);
      await fsp.mkdir(root, { recursive: true });
      if (state === 'reservation') {
        await fsp.writeFile(guard, 'other reservation');
      } else if (state === 'directory race') {
        vi.spyOn(fs, 'mkdir').mockImplementation(async (path, ...args) => {
          if (path === oldDir) {
            await fsp.mkdir(oldDir);
            await fsp.writeFile(joinPath(oldDir, 'portos-db.sql'), 'old dump');
          }
          return fsp.mkdir(path, ...args);
        });
      } else {
        await fsp.mkdir(oldDir);
        await fsp.writeFile(joinPath(oldDir, 'portos-db.sql'), 'old dump');
        if (state === 'failed') await fsp.writeFile(joinPath(oldDir, '.failed'), 'old failure');
        if (state === 'interrupted') await fsp.writeFile(guard, 'other reservation');
      }
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = runBackup(destRoot).catch(error => error);
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      const newDir = dirname(spawn.mock.calls[0][1].at(-1));
      expect(basename(newDir)).not.toBe(oldId);
      await expect(fsp.access(joinPath(root, `.${basename(newDir)}.in-progress`))).resolves.toBeUndefined();
      proc.emit('close', 1);
      expect(await pending).toBeInstanceOf(Error);
      if (state !== 'reservation') expect(await fsp.readFile(joinPath(oldDir, 'portos-db.sql'), 'utf8')).toBe('old dump');
      if (state === 'failed') expect(await fsp.readFile(joinPath(oldDir, '.failed'), 'utf8')).toBe('old failure');
      if (state === 'reservation') expect(await fsp.readFile(guard, 'utf8')).toBe('other reservation');
      else await expect(fsp.access(guard)).rejects.toThrow();
      // The new run converged the dead run's snapshot to a durable failure.
      if (state === 'interrupted') expect(await fsp.readFile(joinPath(oldDir, '.failed'), 'utf8')).toBe('interrupted by restart');
    } finally {
      vi.useRealTimers();
    }
  });

  it('allocates distinct completed snapshots within the same second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    try {
      const ids = [];
      for (let i = 0; i < 2; i += 1) {
        const proc = fakeProc();
        spawn.mockReturnValue(proc);
        const pending = runBackup(destRoot);
        await waitFor(() => spawn.mock.calls.length === i + 1, 'rsync spawn');
        proc.emit('close', 0);
        ids.push((await pending).snapshotId);
      }
      expect(new Set(ids).size).toBe(2);
      const { listSnapshots } = await import('./backup.js');
      const snapshots = await listSnapshots(destRoot);
      expect(snapshots.map(snapshot => snapshot.id).sort()).toEqual(ids.sort());
      expect(snapshots.every(snapshot => !snapshot.incomplete && !snapshot.failed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 1])('invalidates scheduled backups only after readable lifecycle transitions (exit %s)', async (exitCode) => {
    const { dashboardEvents } = await import('./dashboardEvents.js');
    const { getState, listSnapshots } = await import('./backup.js');
    const reads = [];
    const listener = () => reads.push(Promise.all([getState(), listSnapshots(destRoot)]));
    dashboardEvents.on('backup:changed', listener);
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    try {
      const pending = runBackup(destRoot, null).catch(error => error);
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      const [started, initialSnapshots] = await reads[0];
      expect(started.status).toBe('running');
      expect(initialSnapshots[0].incomplete).toBe(true);
      proc.emit('close', exitCode);
      const result = await pending;
      expect(reads).toHaveLength(2);
      const [finished, snapshots] = await reads[1];
      expect(finished.status).toBe(exitCode ? 'error' : 'ok');
      expect(snapshots[0].incomplete).toBe(false);
      expect(Boolean(snapshots[0].failed)).toBe(Boolean(exitCode));
      if (exitCode) expect(result).toBeInstanceOf(Error);
    } finally {
      dashboardEvents.off('backup:changed', listener);
    }
  });

  it('publishes a snapshot when an external volume rejects POSIX chmod', async () => {
    const fsp = await actualFs();
    const chmod = vi.spyOn(fs, 'chmod').mockImplementation(async (path, mode) => {
      if (path.startsWith(destRoot)) throw Object.assign(new Error('Unsupported mode'), { code: 'ENOTSUP' });
      return fsp.chmod(path, mode);
    });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, recordingOperatorIo());
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    proc.emit('close', 0);
    const result = await pending;
    expect(result.status).toBe('ok');
    expect(chmod).toHaveBeenCalledWith(expect.stringContaining('manifest.json.'), 0o600);
  });

  it('rsyncs, writes a manifest and state, and emits started/completed', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const pending = runBackup(destRoot, io, { excludePaths: ['/my-custom-dir/'] });
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');

    // Stand in for what rsync would have copied, so generateManifest hashes a
    // real file and fileCount reflects actual snapshot contents.
    const snapshotDir = await findSnapshotDir();
    const fsp = await actualFs();
    const snapshotId = basename(snapshotDir);
    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .resolves.toBeUndefined();
    const snapshotDataDir = joinPath(snapshotDir, 'data');
    await fsp.writeFile(joinPath(snapshotDataDir, 'settings.json'), '{"a":1}');
    // Simulate rsync --archive copying a source root with broader permissions.
    if (process.platform !== 'win32') await fsp.chmod(snapshotDataDir, 0o755);

    proc.stdout.emit('data', Buffer.from(
      '>f+++++++++ settings.json\n' +
      '<f.st...... notes.json\n' +
      'cd+++++++++ some-dir/\n' // not > or < — must not count as a changed file
    ));
    proc.emit('close', 0);
    const result = await pending;

    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .rejects.toThrow();

    // --- rsync invocation -------------------------------------------------
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('rsync');
    expect(opts).toEqual({ shell: false });
    expect(args.slice(0, 3)).toEqual(['--archive', '--itemize-changes', '--progress']);
    // Source is PATHS.data with a trailing slash (copy contents, not the dir);
    // destination is the snapshot's data/ subdir.
    expect(args.at(-2)).toBe(`${dataRoot}/`);
    expect(args.at(-1)).toBe(joinPath(snapshotDir, 'data'));
    // The user exclude and a non-overridable default each arrive as an
    // `--exclude <path>` pair, not a bare positional.
    for (const path of ['/my-custom-dir/', '/browser-profile/']) {
      const at = args.indexOf(path);
      expect(at, `${path} missing from rsync argv`).toBeGreaterThan(-1);
      expect(args[at - 1]).toBe('--exclude');
    }

    // --- return value -----------------------------------------------------
    expect(result.snapshotId).toBe(basename(snapshotDir));
    expect(result.filesChanged).toBe(2);
    expect(result.status).toBe('ok');
    expect(result.pgBackup).toEqual(SKIPPED_PG);
    if (process.platform !== 'win32') expect((await fsp.stat(snapshotDataDir)).mode & 0o777).toBe(0o700);

    // --- manifest ---------------------------------------------------------
    const manifest = await readJson(joinPath(snapshotDir, 'manifest.json'));
    expect(manifest.fileCount).toBe(1);
    expect(manifest.files['settings.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest).toEqual(manifest);
    // The snapshot never claims global file-and-row consistency while the
    // owner inventory still lists owners outside admission (#9982).
    const { backupAssetConsistency } = await import('../lib/backupAssetOwners.js');
    // The count of dead-owner leases retired at this cut rides along (#16388).
    const claimed = { ...backupAssetConsistency(), reclaimedLeases: 0 };
    expect(claimed.scope).toBe('global');
    expect(manifest.assetConsistency).toEqual(claimed);
    expect(result.assetConsistency).toEqual(claimed);

    // --- persisted state --------------------------------------------------
    const state = await readJson(joinPath(dataRoot, 'backup', 'state.json'));
    expect(state).toMatchObject({
      lastRun: result.lastRun,
      lastSuccessfulRun: result.lastRun,
      lastSnapshotId: result.snapshotId,
      status: 'ok',
      filesChanged: 2,
      pgBackup: SKIPPED_PG,
      assetConsistency: claimed,
      error: null,
    });

    // --- socket events ----------------------------------------------------
    expect(io.emit.mock.calls).toEqual([
      ['backup:started', { snapshotId: result.snapshotId }],
      ['backup:completed', {
        snapshotId: result.snapshotId,
        filesChanged: 2,
        status: 'ok',
        pgBackup: SKIPPED_PG,
        restoreWarning: null,
        error: null,
      }],
    ]);
  });

  it('keeps a newly admitted music take out of both halves of a snapshot', async () => {
    const fsp = await actualFs();
    const { withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
    const sourceMusic = joinPath(dataRoot, 'music');
    await fsp.mkdir(sourceMusic, { recursive: true });
    await fsp.writeFile(joinPath(sourceMusic, 'old.wav'), 'old audio');
    let rowFilename = 'old.wav';
    const rsync = fakeProc();
    const pg = fakeProc();
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(pg);

    const pending = runBackup(destRoot);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotDir = await findSnapshotDir();
    const capturedMusic = joinPath(snapshotDir, 'data', 'music');
    await fsp.mkdir(capturedMusic, { recursive: true });
    await fsp.copyFile(joinPath(sourceMusic, rowFilename), joinPath(capturedMusic, rowFilename));

    let published = false;
    const newTake = withBackupAssetPublication(async () => {
      await fsp.writeFile(joinPath(sourceMusic, 'new.wav'), 'new audio');
      rowFilename = 'new.wav';
      published = true;
    });
    await Promise.resolve();
    expect(published).toBe(false);

    rsync.emit('close', 0);
    await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
    const capturedRow = rowFilename;
    const dumpPath = spawn.mock.calls[1][1][spawn.mock.calls[1][1].indexOf('-f') + 1];
    await fsp.writeFile(dumpPath, `${DUMP_HEADER}${DUMP_TABLES}CREATE TABLE public.tracks (audio_filename text);\nCOPY public.tracks (audio_filename) FROM stdin;\n${capturedRow}\n\\.\n${DUMP_TRAILER}`);
    pg.emit('close', 0);
    await pending;
    await newTake;

    expect(capturedRow).toBe('old.wav');
    expect(await fsp.readFile(joinPath(capturedMusic, capturedRow), 'utf8')).toBe('old audio');
    await expect(fsp.access(joinPath(capturedMusic, 'new.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rowFilename).toBe('new.wav');
    expect(published).toBe(true);
  });

  describe('snapshot cut failures', () => {
    const OLD_IDS = ['2020-01-01T00-00-00', '2020-01-02T00-00-00'];

    // Two completed snapshots with retentionCount 1: a run that wrongly reached
    // retention pruning would delete the older one.
    async function seedCompletedSnapshots() {
      const fsp = await actualFs();
      for (const id of OLD_IDS) {
        const dir = joinPath(destRoot, 'snapshots', machineHost, id);
        await fsp.mkdir(joinPath(dir, 'data'), { recursive: true });
        await fsp.writeFile(joinPath(dir, 'manifest.json'), JSON.stringify({ generatedAt: `${id.slice(0, 10)}T00:00:00.000Z`, fileCount: 0 }));
      }
    }

    async function expectFailedSnapshotWithoutPruning() {
      const { listSnapshots, getState } = await import('./backup.js');
      const snapshots = await listSnapshots(destRoot);
      expect(snapshots.map(snapshot => snapshot.id)).toEqual(expect.arrayContaining(OLD_IDS));
      expect(snapshots).toHaveLength(OLD_IDS.length + 1);
      const [failed, ...rest] = [...snapshots].sort((a, b) => Number(Boolean(b.failed)) - Number(Boolean(a.failed)));
      expect(failed).toMatchObject({ failed: true, incomplete: false });
      expect(rest.every(snapshot => !snapshot.failed && !snapshot.incomplete)).toBe(true);
      expect((await getState()).status).toBe('error');
      expect(isBackupInProgress()).toBe(false);
    }

    afterEach(() => { snapshotCutSeam.wrap = null; maintenanceFence.fenced = false; });

    it('fails the snapshot without copying, publishing or pruning when admitted takes cannot drain, then reopens admission', async () => {
      const { withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
      await seedCompletedSnapshots();
      let finishTake;
      const stuckTake = withBackupAssetPublication(() => new Promise(resolve => { finishTake = resolve; }));
      snapshotCutSeam.wrap = (acquire) => acquire({ timeoutMs: 20 });

      await expect(runBackup(destRoot, null, { retentionCount: 1 }))
        .rejects.toThrow('Timed out draining asset publications');

      expect(spawn).not.toHaveBeenCalled();
      await expectFailedSnapshotWithoutPruning();
      await expect(withBackupAssetPublication(() => 'admitted')).resolves.toBe('admitted');
      finishTake();
      await stuckTake;
    });

    it('refuses to start while database maintenance is fenced, without reserving a snapshot or pruning', async () => {
      await seedCompletedSnapshots();
      maintenanceFence.fenced = true;
      try {
        await expect(runBackup(destRoot, null, { retentionCount: 1 })).rejects.toMatchObject({ code: 'DATABASE_MAINTENANCE' });
      } finally {
        maintenanceFence.fenced = false;
      }
      expect(spawn).not.toHaveBeenCalled();
      const { listSnapshots, getState } = await import('./backup.js');
      expect((await listSnapshots(destRoot)).map(snapshot => snapshot.id).sort()).toEqual(OLD_IDS);
      expect((await getState()).status).toBe('error');
      expect(isBackupInProgress()).toBe(false);
    });

    it('closes the cut when maintenance fences while admitted takes drain, leaving the admitted take intact', async () => {
      const { withBackupAssetPublication, _backupSnapshotWaitersForTests } = await import('../lib/backupSnapshotBoundary.js');
      await seedCompletedSnapshots();
      let finishTake;
      let takeCompleted = false;
      const admittedTake = withBackupAssetPublication(() => new Promise(resolve => { finishTake = resolve; })).then(() => { takeCompleted = true; });
      const pending = runBackup(destRoot, null, { retentionCount: 1 }).catch(error => error);
      // Fence only once the backup's cut is parked draining the admitted take.
      await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().drains).toBe(1), { interval: 5 });
      maintenanceFence.fenced = true;
      finishTake();
      await admittedTake;
      expect(await pending).toMatchObject({ code: 'DATABASE_MAINTENANCE' });
      maintenanceFence.fenced = false;
      expect(takeCompleted).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      await expectFailedSnapshotWithoutPruning();
      await expect(withBackupAssetPublication(() => 'admitted')).resolves.toBe('admitted');
    });

    it('fails the snapshot without pruning when the cut cannot be released', async () => {
      await seedCompletedSnapshots();
      snapshotCutSeam.wrap = async (acquire, ...args) => {
        const release = await acquire(...args);
        return () => {
          release();
          throw new Error('cut release failed');
        };
      };
      const proc = fakeProc();
      spawn.mockReturnValue(proc);

      const pending = runBackup(destRoot, null, { retentionCount: 1 }).catch(error => error);
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      proc.emit('close', 0);

      expect(await pending).toMatchObject({ message: 'cut release failed' });
      await expectFailedSnapshotWithoutPruning();
    });
  });

  it.each([
    ['data readdir', 'EIO'],
    ['data readdir', 'EACCES'],
    ['data stat', 'EIO'],
    ['data stat', 'ENOENT'],
    ['dump stat', 'EACCES'],
    ['dump stat', 'EIO'],
  ])('fails on %s %s and succeeds after repair', async (operation, code) => {
    const fsp = await actualFs();
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotDir = await findSnapshotDir();
    const dataDir = joinPath(snapshotDir, 'data');
    const entryPath = joinPath(dataDir, 'example.json');
    await fsp.writeFile(entryPath, '{}');
    const fault = Object.assign(new Error('private filesystem details'), { code });
    const expected = `Backup manifest ${operation} failed (${code})`;
    const method = operation === 'data readdir' ? 'readdir' : 'stat';
    const target = operation === 'data readdir' ? dataDir
      : operation === 'data stat' ? entryPath : joinPath(snapshotDir, 'portos-db.sql');
    const spy = vi.spyOn(fs, method).mockImplementation((path, ...args) =>
      path === target ? Promise.reject(fault) : fsp[method](path, ...args));
    const rejected = expect(pending).rejects.toThrow(expected);
    proc.emit('close', 0);
    await rejected;

    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
      .toMatchObject({ status: 'error', error: expected });
    expect(io.emit.mock.calls.filter(([event]) => event === 'backup:completed')).toEqual([]);
    expect(io.emit).toHaveBeenCalledWith('backup:failed', {
      snapshotId: basename(snapshotDir), error: expected,
    });
    await expect(fsp.access(joinPath(snapshotDir, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    spy.mockRestore();
    fs.stat.mockImplementation(fsp.stat);
    spawn.mockClear();
    const retryProc = fakeProc();
    spawn.mockReturnValue(retryProc);
    const retry = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'retry rsync');
    retryProc.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ status: 'ok' });
    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
      .toMatchObject({ status: 'ok', error: null });
  });

  it.each([
    ['skipped', 'file', 'ok'],
    ['failed', 'postgres', 'degraded'],
  ])('allows an empty inventory and absent %s dump', async (pgStatus, backend, status) => {
    process.env.MEMORY_BACKEND = backend;
    getBackendName.mockReturnValue(null);
    // Production subscribes to the error bus; EventEmitter otherwise throws
    // an unhandled 'error' while broadcasting the expected degraded warning.
    const { errorEvents } = await import('../lib/errorHandler.js');
    const warning = vi.fn();
    if (pgStatus === 'failed') errorEvents.once('error', warning);
    const priorRun = '2026-01-01T00:00:00.000Z';
    const fsp = await actualFs();
    await fsp.mkdir(joinPath(dataRoot, 'backup'), { recursive: true });
    await fsp.writeFile(joinPath(dataRoot, 'backup', 'state.json'), JSON.stringify({ status: 'ok', lastRun: priorRun }));
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    proc.emit('close', 0);
    const result = await pending;
    expect(result).toMatchObject({
      status, pgBackup: { status: pgStatus }, manifest: { fileCount: 0, files: {} },
    });
    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
      .toMatchObject({ status, pgBackup: { status: pgStatus }, lastRun: result.lastRun,
        lastSuccessfulRun: pgStatus === 'failed' ? priorRun : result.lastRun });
    expect(io.emit).toHaveBeenCalledWith('backup:completed', expect.objectContaining({ status }));
    if (pgStatus === 'failed') expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BACKUP_DB_DUMP_FAILED' }), expect.any(Object));
  });

  it('fails if a successful dump disappears before inventory', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    getServerMajorVersion.mockResolvedValue(null);
    const fsp = await actualFs();
    const io = recordingOperatorIo();
    const rsync = fakeProc();
    const pg = fakeProc();
    spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(pg);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotDir = await findSnapshotDir();
    const dumpPath = joinPath(snapshotDir, 'portos-db.sql');
    rsync.emit('close', 0);
    await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
    await fsp.writeFile(dumpPath, COMPLETE_DUMP);
    // Enumeration starts only after dumpPostgres has verified and returned ok.
    vi.spyOn(fs, 'readdir').mockImplementation(async (path, ...args) => {
      if (path === joinPath(snapshotDir, 'data')) await fsp.unlink(dumpPath);
      return fsp.readdir(path, ...args);
    });
    const rejected = expect(pending).rejects.toThrow('Backup manifest dump stat failed (ENOENT)');
    pg.emit('close', 0);
    await rejected;
    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
      .toMatchObject({ status: 'error' });
    expect(io.emit.mock.calls.filter(([event]) => event === 'backup:completed')).toEqual([]);
    await expect(fsp.access(joinPath(snapshotDir, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns { skipped: true } for a concurrent call without a second rsync', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const first = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'first rsync spawn');

    // Second call while the first is mid-flight.
    const second = recordingOperatorIo();
    await expect(runBackup(destRoot, second)).resolves.toEqual({ skipped: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(second.emit).not.toHaveBeenCalled();
    // The suppressed call must not announce a run it never started.
    expect(io.emit.mock.calls.filter(([event]) => event === 'backup:started')).toHaveLength(1);

    proc.emit('close', 0);
    await first;
  });

  it('keeps update admission blocked until a backup has finished and releases the fence afterward', async () => {
    const { maintenance } = await import('../lib/maintenanceAdmission.js');
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, recordingOperatorIo());
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const update = maintenance.deferredUpdate.request();
    try {
      expect(maintenance.operations().some(op => op.kind === 'backup')).toBe(true);
      expect(maintenance.operations().find(op => op.kind === 'backup').resource).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(maintenance.deferredUpdate.acquire(update.id)).toBe(false);
      proc.emit('close', 0);
      await pending;
      expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    } finally {
      proc.emit('close', 0);
      await pending.catch(() => {});
      maintenance.deferredUpdate.finish(update.id, false);
    }
  });

  it('does not spawn a backup child if its snapshot identity cannot be recorded', async () => {
    const { maintenance } = await import('../lib/maintenanceAdmission.js');
    const admit = maintenance.admit;
    vi.spyOn(maintenance, 'admit').mockImplementationOnce((...args) => {
      const permit = admit(...args);
      return { ...permit, identify: () => { throw new Error('cannot identify backup'); } };
    });
    await expect(runBackup(destRoot, recordingOperatorIo())).rejects.toThrow('cannot identify backup');
    expect(spawn).not.toHaveBeenCalled();
    expect(maintenance.operations().some(op => op.kind === 'backup')).toBe(false);
  });

  // Feeds the system-idle gate (server/lib/systemIdle.js): a live snapshot
  // must not read as an idle install, or the unattended updater would kill
  // rsync mid-write. `isBackupInProgress` is the signal that gate reads.
  it('isBackupInProgress reflects the in-process run, false before and after', async () => {
    expect(isBackupInProgress()).toBe(false);

    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    expect(isBackupInProgress()).toBe(true);

    proc.emit('close', 0);
    await pending;
    expect(isBackupInProgress()).toBe(false);
    const { drainActivityNotesForTests } = await import('./systemActivityNotify.js');
    expect(drainActivityNotesForTests().map((note) => note.phase)).toEqual(['start', 'completion']);
  });

  // A snapshot mid-assembly would tar/rsync as a truncated tree that looks like
  // a complete backup. Driven through the real runBackup rather than a stubbed
  // marker so the guard is tested against the state that actually gates it.
  it('refuses to download or restore the snapshot currently being written', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const { openSnapshotStream: open, restoreSnapshot: restore } = await import('./backup.js');

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = io.emit.mock.calls[0][1].snapshotId;

    await expect(open(destRoot, snapshotId))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    await expect(restore(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    const { deleteSnapshot: remove } = await import('./backup.js');
    await expect(remove(destRoot, snapshotId))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    // Only the rsync — neither guard reached tar or a second rsync.
    expect(spawn).toHaveBeenCalledTimes(1);

    proc.emit('close', 0);
    await pending;
  });

  it('persists a failed snapshot across restart, blocks both restores, and keeps salvage download available', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = io.emit.mock.calls[0][1].snapshotId;
    proc.emit('close', 23);
    await expect(pending).rejects.toThrow(/rsync exited with code 23/);

    const snapshotDir = await findSnapshotDir();
    const fsp = await actualFs();
    await expect(fsp.access(joinPath(snapshotDir, '.failed'))).resolves.toBeUndefined();
    await expect(fsp.access(joinPath(snapshotDir, '.in-progress'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .rejects.toMatchObject({ code: 'ENOENT' });

    // Module restart clears activeSnapshotId; the on-disk marker remains the
    // sole source of failure classification and restore refusal.
    vi.resetModules();
    const {
      listSnapshots: listAfterRestart,
      openSnapshotStream: openAfterRestart,
      restoreSnapshot: restoreFilesAfterRestart,
      restorePostgres: restoreDbAfterRestart,
    } = await import('./backup.js');

    await expect(listAfterRestart(destRoot)).resolves.toContainEqual(expect.objectContaining({
      id: snapshotId,
      failed: true,
      incomplete: false,
    }));
    spawn.mockClear();
    await expect(restoreFilesAfterRestart(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({
        status: 409,
        code: 'SNAPSHOT_FAILED',
        message: expect.stringContaining('Choose a completed backup'),
      });
    await expect(restoreDbAfterRestart(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({
        status: 409,
        code: 'SNAPSHOT_FAILED',
        message: expect.stringContaining('Choose a completed backup'),
      });
    expect(spawn).not.toHaveBeenCalled();

    const tar = fakeProc();
    spawn.mockReturnValue(tar);
    const stream = await openAfterRestart(destRoot, snapshotId);
    expect(stream).toBeDefined();
    stream.destroy();
  });

  it.each(['snapshot', 'reservation', 'failed'])('reports %s marker cleanup failure instead of publishing a completed backup', async (marker) => {
    const fsp = await actualFs();
    const { getState } = await import('./backup.js');
    const oldIds = ['2020-01-01T00-00-00', '2020-01-02T00-00-00'];
    const snapshotsRoot = joinPath(destRoot, 'snapshots', machineHost);
    for (const id of oldIds) {
      await fsp.mkdir(joinPath(snapshotsRoot, id, 'data'), { recursive: true });
      await fsp.writeFile(joinPath(snapshotsRoot, id, 'manifest.json'), '{}');
    }
    const priorRun = '2020-01-02T00:00:00.000Z';
    await fsp.mkdir(joinPath(dataRoot, 'backup'), { recursive: true });
    await fsp.writeFile(joinPath(dataRoot, 'backup', 'state.json'), JSON.stringify({
      status: 'ok', lastSnapshotId: oldIds[1], lastRun: priorRun, error: null,
    }));
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io, { retentionCount: 1 });
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
    const snapshotDir = joinPath(snapshotsRoot, snapshotId);
    const target = marker === 'reservation' ? joinPath(snapshotsRoot, `.${snapshotId}.in-progress`)
      : joinPath(snapshotDir, marker === 'failed' ? '.failed' : '.in-progress');
    fs.unlink.mockImplementation(async (path, ...args) => {
      if (path !== target) return fsp.unlink(path, ...args);
      if (marker === 'reservation') {
        expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
          .toMatchObject({ lastSuccessfulRun: priorRun });
      }
      throw Object.assign(new Error('private destination details'), { code: 'EACCES' });
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'BACKUP_SNAPSHOT_FINALIZATION_FAILED',
      message: `Backup snapshot finalization failed (${marker} marker, EACCES)`,
    });
    proc.emit('close', 0);
    await rejection;

    expect(await getState()).toMatchObject({
      status: 'error', lastSnapshotId: oldIds[1], lastSuccessfulRun: priorRun,
      error: `Backup snapshot finalization failed (${marker} marker, EACCES)`,
    });
    expect(io.emit.mock.calls.some(([event]) => event === 'backup:completed')).toBe(false);
    expect(io.emit).toHaveBeenCalledWith('backup:failed', {
      snapshotId, error: `Backup snapshot finalization failed (${marker} marker, EACCES)`,
    });
    expect(isBackupInProgress()).toBe(false);
    for (const id of oldIds) await expect(fsp.access(joinPath(snapshotsRoot, id))).resolves.toBeUndefined();
    await expect(fsp.access(joinPath(snapshotDir, '.failed'))).resolves.toBeUndefined();
    await expect(restoreSnapshot(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retains a durable guard when completion state and failure-marker persistence both fail', async () => {
    const fsp = await actualFs();
    const { atomicWrite } = await import('../lib/fileUtils.js');
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = io.emit.mock.calls[0][1].snapshotId;
    const snapshotDir = await findSnapshotDir();
    atomicWrite.mockImplementationOnce(async (path, ...args) => {
      if (path.endsWith('manifest.json')) return (await vi.importActual('../lib/fileUtils.js')).atomicWrite(path, ...args);
      throw new Error('unexpected write');
    }).mockRejectedValueOnce(new Error('completion status unavailable'));
    fs.writeFile.mockImplementation((path, ...args) => path === joinPath(snapshotDir, '.failed')
      ? Promise.reject(Object.assign(new Error('failure marker unavailable'), { code: 'EACCES' }))
      : fsp.writeFile(path, ...args));
    const rejected = expect(pending).rejects.toThrow('completion status unavailable');
    proc.emit('close', 0);
    await rejected;
    expect(isBackupInProgress()).toBe(false);
    expect(io.emit.mock.calls.some(([event]) => event === 'backup:completed')).toBe(false);
    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .resolves.toBeUndefined();
    // The on-disk guard, not process state, must block restore after restart,
    // where the dead process's token makes the snapshot interrupted.
    vi.resetModules();
    const { restoreSnapshot: restoreAfterRestart } = await import('./backup.js');
    await expect(restoreAfterRestart(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INTERRUPTED' });
  });

  it('retains incomplete guards when the failed marker cannot be written while releasing the process lock', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotDir = await findSnapshotDir();
    const snapshotId = basename(snapshotDir);
    const fsp = await actualFs();
    fs.writeFile.mockImplementation((path, ...args) => String(path).endsWith('.failed')
      ? Promise.reject(Object.assign(new Error('read-only destination'), { code: 'EACCES' }))
      : fsp.writeFile(path, ...args));

    proc.emit('close', 23);
    await expect(pending).rejects.toThrow(/rsync exited with code 23/);

    await expect(fsp.access(joinPath(snapshotDir, '.failed'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.access(joinPath(snapshotDir, '.in-progress'))).resolves.toBeUndefined();
    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .resolves.toBeUndefined();

    const { openSnapshotStream: open, restoreSnapshot: restore } = await import('./backup.js');
    spawn.mockClear();
    await expect(open(destRoot, snapshotId))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    await expect(restore(destRoot, snapshotId, { dryRun: true }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    expect(spawn).not.toHaveBeenCalled();

    // Failure-state persistence cannot strand the process-level running lock.
    const retryRoot = await fsp.mkdtemp(joinPath(tmpdir(), 'portos-backup-retry-'));
    const retryProc = fakeProc();
    spawn.mockReturnValue(retryProc);
    const retry = runBackup(retryRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'retry rsync spawn');
    retryProc.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ status: 'ok' });
    await fsp.rm(retryRoot, { recursive: true, force: true });
  });

  it('on rsync failure: releases the lock, records status error, emits backup:failed, and rethrows', async () => {
    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    proc.stderr.emit('data', Buffer.from('rsync: mkstemp failed: Permission denied (13)'));
    proc.emit('close', 23);

    await expect(pending).rejects.toThrow(/rsync exited with code 23: rsync: mkstemp failed/);

    const snapshotId = io.emit.mock.calls[0][1].snapshotId;
    const failure = io.emit.mock.calls.find(([event]) => event === 'backup:failed');
    expect(failure[1].snapshotId).toBe(snapshotId);
    expect(failure[1].error).toMatch(/rsync exited with code 23/);
    expect(io.emit.mock.calls.some(([event]) => event === 'backup:completed')).toBe(false);

    const state = await readJson(joinPath(dataRoot, 'backup', 'state.json'));
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/rsync exited with code 23/);
    expect(state.pgBackup).toBeNull();
    const { drainActivityNotesForTests } = await import('./systemActivityNotify.js');
    expect(drainActivityNotesForTests().map((note) => note.phase)).toEqual(['start', 'failure']);
    // No manifest is written for a failed run.
    const fsp = await actualFs();
    await expect(fsp.stat(joinPath(await findSnapshotDir(), 'manifest.json'))).rejects.toThrow();

    // isRunning must have been reset: the next run proceeds instead of
    // short-circuiting to { skipped: true }.
    const retryProc = fakeProc();
    spawn.mockReturnValue(retryProc);
    const retry = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 2, 'retry rsync spawn');
    retryProc.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ status: 'ok' });
  });

  it('kills stalled rsync, waits for child close, clears markers, and permits retry', async () => {
    const realSetTimeout = globalThis.setTimeout;
    let fireIdleTimeout;
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 10 * 60 * 1000 && !fireIdleTimeout) {
        fireIdleTimeout = callback;
        const timer = realSetTimeout(() => {}, delay, ...args);
        timer.unref?.();
        return timer;
      }
      return realSetTimeout(callback, delay, ...args);
    });

    const io = recordingOperatorIo();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await waitFor(() => spawn.mock.calls.length === 1 && fireIdleTimeout, 'rsync watchdog');
    const snapshotDir = await findSnapshotDir();
    const snapshotId = basename(snapshotDir);
    const fsp = await actualFs();
    fireIdleTimeout();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await Promise.resolve();
    expect(settled).toBe(false);
    proc.emit('close', null, 'SIGTERM');
    await expect(pending).rejects.toThrow(/10 minutes without progress/);
    expect(settled).toBe(true);
    await expect(fsp.access(joinPath(snapshotDir, '.in-progress'))).rejects.toThrow();
    await expect(fsp.access(joinPath(destRoot, 'snapshots', machineHost, `.${snapshotId}.in-progress`)))
      .rejects.toThrow();

    timerSpy.mockRestore();
    const retryProc = fakeProc();
    spawn.mockReturnValue(retryProc);
    const retry = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 2, 'retry rsync spawn');
    retryProc.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ status: 'ok' });
  });

  it('on PostgreSQL setup failure: releases the lock, records status error, and permits retry', async () => {
    const io = recordingOperatorIo();
    const firstProc = fakeProc();
    spawn.mockReturnValue(firstProc);
    checkHealth.mockRejectedValueOnce(new Error('database health unavailable'));

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    firstProc.emit('close', 0);
    await expect(pending).rejects.toThrow('database health unavailable');

    const failed = io.emit.mock.calls.find(([event]) => event === 'backup:failed');
    expect(failed?.[1]?.error).toBe('database health unavailable');
    expect((await readJson(joinPath(dataRoot, 'backup', 'state.json'))).status).toBe('error');

    const retryProc = fakeProc();
    spawn.mockReturnValue(retryProc);
    const retry = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 2, 'retry rsync spawn');
    retryProc.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ status: 'ok' });
  });

  it('projects a failed scheduled attempt when state persistence fails, then recovers', async () => {
    const { saveState, getState, listSnapshots } = await import('./backup.js');
    const { atomicWrite } = await import('../lib/fileUtils.js');
    await saveState({ lastSnapshotId: 'previous-snapshot', status: 'ok', error: null });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot).catch(error => error);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = basename(await findSnapshotDir());
    const persistedBefore = await readJson(joinPath(dataRoot, 'backup', 'state.json'));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    atomicWrite.mockRejectedValueOnce(Object.assign(new Error('private path and credential'), { code: 'EACCES' }));
    proc.emit('close', 23);
    expect(await pending).toMatchObject({ message: expect.stringContaining('rsync exited with code 23') });
    expect(isBackupInProgress()).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith(`❌ Backup status persistence failed: transition=error snapshot=${snapshotId} code=EACCES`);
    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json'))).toEqual(persistedBefore);
    expect(await getState()).toMatchObject({
      status: 'error', lastSnapshotId: 'previous-snapshot', pgBackup: null,
      error: 'Backup failed; status persistence failed (EACCES). See server logs.',
    });
    expect((await listSnapshots(destRoot))[0].failed).toBe(true);
    // A rejected subsequent write must not clear the process-local projection.
    atomicWrite.mockRejectedValueOnce(new Error('still unavailable'));
    await expect(saveState({ status: 'ok' })).rejects.toThrow('still unavailable');
    expect((await getState()).status).toBe('error');
    await saveState({ pgBackup: { status: 'skipped' } });
    expect(await getState()).toMatchObject({ status: 'ok', error: null, lastSnapshotId: 'previous-snapshot' });
    expect(await readJson(joinPath(dataRoot, 'backup', 'state.json'))).toMatchObject({ status: 'ok', error: null });
    // Prove the overlay is gone, rather than merely masked by matching values.
    const fsp = await actualFs();
    await fsp.writeFile(joinPath(dataRoot, 'backup', 'state.json'), JSON.stringify({ status: 'ok', lastSnapshotId: 'recovered-snapshot' }));
    expect(await getState()).toEqual({ status: 'ok', lastSnapshotId: 'recovered-snapshot' });
  });

  it.each(['ENOENT', 'EACCES', 'EIO'])('persists a failed preflight (%s) over prior success and permits repair', async (code) => {
    const { saveState, getState } = await import('./backup.js');
    const priorRun = '2026-01-01T00:00:00.000Z';
    const fsp = await actualFs();
    await fsp.mkdir(joinPath(dataRoot, 'backup'), { recursive: true });
    await fsp.writeFile(joinPath(dataRoot, 'backup', 'state.json'), JSON.stringify({
      lastRun: priorRun, lastSnapshotId: 'previous-snapshot', status: 'ok', error: null,
    }));
    const io = recordingOperatorIo();
    const cause = Object.assign(new Error('private destination detail'), { code });
    fs.access.mockRejectedValueOnce(cause);
    const attemptStarted = Date.now();

    await expect(runBackup(destRoot, io)).rejects.toMatchObject({
      code: `BACKUP_DESTINATION_${code}`,
      cause
    });
    const state = await getState(); // The status route serves this persisted state.
    expect(state).toMatchObject({
      status: 'error',
      lastSnapshotId: 'previous-snapshot',
      lastSuccessfulRun: priorRun,
      error: `${code === 'ENOENT' ? 'Backup destination not found' : 'Backup destination inaccessible'} (${code})`
    });
    expect(Date.parse(state.lastRun)).toBeGreaterThanOrEqual(attemptStarted);
    expect(JSON.stringify(state)).not.toContain('private destination detail');
    expect(spawn).not.toHaveBeenCalled();
    expect(io.emit.mock.calls).toEqual([['backup:failed', { snapshotId: null, error: state.error }]]);
    expect(await (await actualFs()).readdir(destRoot)).toEqual([]);

    // Scheduled runs have no socket, but must still replace stale status.
    await saveState({ status: 'ok', lastRun: priorRun });
    fs.access.mockRejectedValueOnce(cause);
    await expect(runBackup(destRoot)).rejects.toMatchObject({ cause });
    expect(await getState()).toMatchObject({ status: 'error', lastSnapshotId: 'previous-snapshot' });

    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn after destination repair');
    proc.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ status: 'ok' });
    expect(await getState()).toMatchObject({ status: 'ok', error: null });
  });

  // -----------------------------------------------------------------------
  // Retention pruning (#8334) — after a dump-successful run, the oldest COMPLETED
  // snapshots on THIS machine beyond retentionCount are deleted. Failed and
  // other-source snapshots must never be touched, and retentionCount
  // null/undefined must never prune a completed snapshot (an existing install
  // with no stored value keeps everything — see backupConfig.js). Interrupted
  // snapshots older than the newest completed one are always pruned (#12618).
  // -----------------------------------------------------------------------
  describe('retention pruning', () => {
    async function seedSnapshot(source, id, { generatedAt, marker, markerContent = '', dump = false } = {}) {
      const fsp = await actualFs();
      const dir = joinPath(destRoot, 'snapshots', source, id);
      await fsp.mkdir(joinPath(dir, 'data'), { recursive: true });
      if (generatedAt) {
        const files = dump ? { '../portos-db.sql': createHash('sha256').update(COMPLETE_DUMP).digest('hex') } : {};
        await fsp.writeFile(joinPath(dir, 'manifest.json'), JSON.stringify({ generatedAt, fileCount: Object.keys(files).length, files }));
      }
      if (dump) await fsp.writeFile(joinPath(dir, 'portos-db.sql'), COMPLETE_DUMP);
      if (marker) await fsp.writeFile(joinPath(dir, marker), markerContent);
      return dir;
    }

    async function completeRun(options) {
      const rsync = fakeProc();
      spawn.mockReturnValue(rsync);
      const pending = runBackup(destRoot, null, options);
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);
      return pending;
    }

    it.each(['missing database dump', 'legacy database metadata'])(
      'keeps two healthy database snapshots alongside a degraded snapshot with %s', async (degradation) => {
        const fsp = await actualFs();
        const { restorePostgres } = await import('./backup.js');
        const root = joinPath(destRoot, 'snapshots', machineHost);
        delete process.env.MEMORY_BACKEND;
        getBackendName.mockReturnValue('postgres');
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => vi.useRealTimers());
        const { errorEvents } = await import('../lib/errorHandler.js');

        async function runPostgresBackup(day, { failDump = false, legacyMetadata = false } = {}) {
          vi.setSystemTime(new Date(`2026-01-0${day}T00:00:00Z`));
          if (failDump) errorEvents.once('error', () => {});
          checkHealth.mockResolvedValue({ connected: !failDump, hasSchema: !failDump });
          const rsync = fakeProc();
          const dump = fakeProc();
          spawn.mockClear().mockReturnValueOnce(rsync);
          if (!failDump) spawn.mockReturnValueOnce(dump);
          const io = recordingOperatorIo();
          const pending = runBackup(destRoot, io, { retentionCount: 2 });
          await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
          const id = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
          const dir = joinPath(root, id);
          if (legacyMetadata) await fsp.writeFile(joinPath(dir, 'data', 'creative-director-projects.json'), '[]');
          await fsp.writeFile(joinPath(dir, 'data', 'settings.json'), '{}');
          rsync.emit('close', 0);
          if (!failDump) {
            await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
            await fsp.writeFile(joinPath(dir, 'portos-db.sql'), COMPLETE_DUMP);
            dump.emit('close', 0);
          }
          return pending;
        }

        const first = await runPostgresBackup(1);
        const degraded = await runPostgresBackup(2, {
          failDump: degradation === 'missing database dump',
          legacyMetadata: degradation === 'legacy database metadata',
        });
        const latest = await runPostgresBackup(3);

        expect(degraded).toMatchObject({ status: 'degraded', prunedSnapshots: 0 });
        if (degradation === 'missing database dump') {
          await expect(restorePostgres(destRoot, degraded.snapshotId, { dryRun: true }))
            .resolves.toEqual({ status: 'skipped', reason: 'no_dump' });
        } else {
          expect(degraded.restoreWarning).toMatchObject({ code: 'BACKUP_LEGACY_DB_METADATA' });
          expect(degraded.pgBackup.status).toBe('ok');
        }
        expect(latest).toMatchObject({ status: 'ok', prunedSnapshots: 0 });
        for (const healthy of [first, latest]) {
          expect(healthy.status).toBe('ok');
          getServerMajorVersion.mockResolvedValueOnce(17);
          await expect(restorePostgres(destRoot, healthy.snapshotId, { dryRun: true }))
            .resolves.toMatchObject({ status: 'ok', tableCount: 2 });
        }
        await expect(fsp.readFile(joinPath(root, degraded.snapshotId, 'data', 'settings.json'), 'utf8')).resolves.toBe('{}');
      },
    );

    it('prunes interrupted snapshots older than the new completed one even under unlimited retention', async () => {
      const fsp = await actualFs();
      const completed = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const interrupted = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { marker: '.in-progress', markerContent: 'previous-process-token' });
      const otherMachine = await seedSnapshot('previous-machine', '2020-01-02T00-00-00', { marker: '.in-progress' });

      const result = await completeRun({ retentionCount: null });

      expect(result).toMatchObject({ status: 'ok', prunedSnapshots: 1 });
      await expect(fsp.stat(interrupted)).rejects.toThrow();
      await expect(fsp.stat(completed)).resolves.toBeDefined();
      await expect(fsp.stat(otherMachine)).resolves.toBeDefined();
    });

    it('prunes only the oldest completed snapshots in the current machine namespace, keeping failed/other-source snapshots', async () => {
      const fsp = await actualFs();
      const old1 = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { dump: true });
      const old2 = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2020-01-02T00:00:00.000Z', dump: true });
      const old3 = await seedSnapshot(machineHost, '2020-01-03T00-00-00', { generatedAt: '2020-01-03T00:00:00.000Z', dump: true });
      const interrupted = await seedSnapshot(machineHost, '2020-01-04T00-00-00', { marker: '.in-progress' });
      const failed = await seedSnapshot(machineHost, '2020-01-05T00-00-00', { generatedAt: '2020-01-05T00:00:00.000Z', marker: '.failed' });
      const noManifestOrDump = await seedSnapshot(machineHost, '2020-01-06T00-00-00');
      const generatedAt = '2020-01-07T00:00:00.000Z';
      const unlistedDump = await seedSnapshot(machineHost, '2020-01-07T00-00-00', { generatedAt });
      await fsp.writeFile(joinPath(unlistedDump, 'portos-db.sql'), COMPLETE_DUMP);
      const deletedDump = await seedSnapshot(machineHost, '2020-01-08T00-00-00', { generatedAt, dump: true });
      await fsp.unlink(joinPath(deletedDump, 'portos-db.sql'));
      const emptyDump = await seedSnapshot(machineHost, '2020-01-09T00-00-00', { generatedAt, dump: true });
      await fsp.truncate(joinPath(emptyDump, 'portos-db.sql'), 0);
      const directoryDump = await seedSnapshot(machineHost, '2020-01-10T00-00-00', { generatedAt, dump: true });
      await fsp.unlink(joinPath(directoryDump, 'portos-db.sql'));
      await fsp.mkdir(joinPath(directoryDump, 'portos-db.sql'));
      const otherMachine = await seedSnapshot('previous-machine', '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });

      const io = recordingOperatorIo();
      delete process.env.MEMORY_BACKEND;
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      getBackendName.mockReturnValue('postgres');
      const rsync = fakeProc();
      const pgDump = fakeProc();
      spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(pgDump);
      const pending = runBackup(destRoot, io, { retentionCount: 2 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);
      await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
      const dumpPath = spawn.mock.calls[1][1][spawn.mock.calls[1][1].indexOf('-f') + 1];
      await fsp.writeFile(dumpPath, COMPLETE_DUMP);
      pgDump.emit('close', 0);
      const result = await pending;
      expect(result).toMatchObject({ status: 'ok', pgBackup: { status: 'ok', tableCount: 2 }, prunedSnapshots: 3 });
      expect(result.manifest.files['../portos-db.sql']).toMatch(/^[a-f0-9]{64}$/);
      expect(await readJson(joinPath(dataRoot, 'backup', 'state.json')))
        .toMatchObject({ lastSuccessfulRun: result.lastRun });
      getServerMajorVersion.mockResolvedValueOnce(17);
      const { restorePostgres } = await import('./backup.js');
      await expect(restorePostgres(destRoot, result.snapshotId, { dryRun: true }))
        .resolves.toEqual({ status: 'ok', dryRun: true, sizeBytes: Buffer.byteLength(COMPLETE_DUMP), tableCount: 2 });

      // Keeps the newest 2 completed snapshots on this machine: the run just
      // created and old3. old1 and old2 are pruned, and the interrupted one
      // goes without spending the budget.
      await expect(fsp.stat(old1)).rejects.toThrow();
      await expect(fsp.stat(old2)).rejects.toThrow();
      await expect(fsp.stat(old3)).resolves.toBeDefined();
      const newSnapshotDir = joinPath(destRoot, 'snapshots', machineHost, result.snapshotId);
      await expect(fsp.stat(newSnapshotDir)).resolves.toBeDefined();

      await expect(fsp.stat(interrupted)).rejects.toThrow();
      // Unusable database snapshots, failed snapshots and other namespaces are preserved.
      for (const dir of [noManifestOrDump, unlistedDump, deletedDump, emptyDump, directoryDump, failed, otherMachine]) {
        await expect(fsp.stat(dir)).resolves.toBeDefined();
      }
    });

    it('reports an unreadable retention inventory without failing the completed backup or deleting snapshots', async () => {
      const fsp = await actualFs();
      const old = await seedSnapshot(machineHost, '2020-01-01T00-00-00');
      const namespace = joinPath(destRoot, 'snapshots', machineHost);
      fs.readdir.mockImplementation((path, ...args) => path === namespace
        ? Promise.reject(Object.assign(new Error('private destination detail'), { code: 'EACCES' }))
        : fsp.readdir(path, ...args));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const rsync = fakeProc();
        spawn.mockReturnValue(rsync);
        const pending = runBackup(destRoot, null, { retentionCount: 1 });
        await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
        rsync.emit('close', 0);

        const result = await pending;
        expect(result).toMatchObject({ status: 'ok', prunedSnapshots: 0 });
        await expect(fsp.stat(old)).resolves.toBeDefined();
        await expect(fsp.stat(joinPath(namespace, result.snapshotId))).resolves.toBeDefined();
        expect(errorLog).toHaveBeenCalledWith(
          '❌ Backup retention prune failed: Backup inventory unavailable: read-retention-namespace (EACCES)'
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private destination detail');
      } finally {
        errorLog.mockRestore();
      }
    });

    it('publishes a degraded file snapshot and releases waiting asset work after a database probe timeout', async () => {
      const fsp = await actualFs();
      const old1 = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const old2 = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2020-01-02T00:00:00.000Z' });
      process.env.MEMORY_BACKEND = 'postgres';
      const health = Promise.withResolvers();
      checkHealth.mockReturnValueOnce(health.promise);
      const rsync = fakeProc();
      spawn.mockReturnValueOnce(rsync);
      const { errorEvents } = await import('../lib/errorHandler.js');
      const { withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
      const warning = vi.fn();
      errorEvents.once('error', warning);
      const io = recordingOperatorIo();
      const pending = runBackup(destRoot, io, { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      const snapshotId = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
      const snapshotDir = joinPath(destRoot, 'snapshots', machineHost, snapshotId);
      await fsp.writeFile(joinPath(snapshotDir, 'data', 'settings.json'), '{}');
      rsync.emit('close', 0);
      await waitFor(() => checkHealth.mock.calls.length === 1, 'database health probe');

      const publish = vi.fn();
      const waiting = withBackupAssetPublication(publish, { timeoutMs: 3000 });
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      health.resolve({ connected: false, hasSchema: false, error: 'Query read timeout' });
      const [result] = await Promise.all([pending, waiting]);

      expect(publish).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: 'degraded', prunedSnapshots: 0,
        pgBackup: { status: 'failed', reason: 'pg_unreachable', error: 'Query read timeout' },
        manifest: { files: { 'settings.json': expect.stringMatching(/^[a-f0-9]{64}$/) } },
      });
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'BACKUP_DB_DUMP_FAILED' }), expect.any(Object));
      await expect(fsp.access(old1)).resolves.toBeUndefined();
      await expect(fsp.access(old2)).resolves.toBeUndefined();
    });

    it.each([
      ['non-zero exit', 1, COMPLETE_DUMP, 'dump_error', ''],
      ['missing completion marker', 0, DUMP_HEADER + DUMP_TABLES, 'dump_incomplete', 'the pg_dump completion marker'],
      ['missing memories', 0, COMPLETE_DUMP.replace(/CREATE TABLE public\.memories [^;]+;/, ''), 'dump_incomplete', 'table memories'],
      ['missing memory_links', 0, COMPLETE_DUMP.replace(/CREATE TABLE public\.memory_links [^;]+;/, ''), 'dump_incomplete', 'table memory_links'],
    ])('keeps a file-only snapshot and preserves older snapshots after dump failure: %s', async (_scenario, exitCode, sql, reason, detail) => {
      const fsp = await actualFs();
      const priorRun = '2020-01-02T00:00:00.000Z';
      const statePath = joinPath(dataRoot, 'backup', 'state.json');
      await fsp.mkdir(dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify({ status: 'ok', lastRun: priorRun, lastSuccessfulRun: priorRun }));
      const old1 = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const old2 = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2020-01-02T00:00:00.000Z' });

      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      getBackendName.mockReturnValue('postgres');
      const rsync = fakeProc();
      const pgDump = fakeProc();
      spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(pgDump);
      const { errorEvents } = await import('../lib/errorHandler.js');
      errorEvents.once('error', () => {});
      const io = recordingOperatorIo();
      const pending = runBackup(destRoot, io, { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      const snapshotId = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
      const snapshotDir = joinPath(destRoot, 'snapshots', machineHost, snapshotId);
      await fsp.writeFile(joinPath(snapshotDir, 'data', 'settings.json'), '{}');
      rsync.emit('close', 0);
      await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
      const dumpPath = joinPath(snapshotDir, 'portos-db.sql');
      await fsp.writeFile(dumpPath, sql);
      pgDump.emit('close', exitCode);

      const result = await pending;
      expect(result).toMatchObject({ status: 'degraded', pgBackup: { status: 'failed', reason }, prunedSnapshots: 0 });
      if (detail) expect(result.pgBackup.error).toContain(detail);
      expect(result.manifest.files).toEqual({ 'settings.json': expect.stringMatching(/^[a-f0-9]{64}$/) });
      await expect(fsp.access(dumpPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readJson(statePath)).toMatchObject({
        status: 'degraded', lastRun: result.lastRun, lastSuccessfulRun: priorRun, pgBackup: result.pgBackup,
      });
      const { restorePostgres } = await import('./backup.js');
      await expect(restorePostgres(destRoot, snapshotId)).resolves.toEqual({ status: 'skipped', reason: 'no_dump' });
      await expect(fsp.stat(old1)).resolves.toBeDefined();
      await expect(fsp.stat(old2)).resolves.toBeDefined();
    });

    it('leaves a failed snapshot when the rejected dump cannot be removed', async () => {
      const fsp = await actualFs();
      const old = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      const rsync = fakeProc();
      const pgDump = fakeProc();
      spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(pgDump);
      const io = recordingOperatorIo();
      const pending = runBackup(destRoot, io, { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);
      await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
      const snapshotId = io.emit.mock.calls.find(([event]) => event === 'backup:started')[1].snapshotId;
      const snapshotDir = joinPath(destRoot, 'snapshots', machineHost, snapshotId);
      const dumpPath = joinPath(snapshotDir, 'portos-db.sql');
      await fsp.writeFile(dumpPath, DUMP_HEADER + DUMP_TABLES);
      vi.spyOn(fs, 'unlink').mockImplementation(path => path === dumpPath
        ? Promise.reject(Object.assign(new Error('private filesystem detail'), { code: 'EACCES' }))
        : fsp.unlink(path));
      const rejected = expect(pending).rejects.toThrow('Backup dump cleanup failed (EACCES)');
      pgDump.emit('close', 0);
      await rejected;
      await expect(fsp.access(old)).resolves.toBeUndefined();
      await expect(fsp.access(joinPath(snapshotDir, '.failed'))).resolves.toBeUndefined();
      await expect(fsp.access(joinPath(snapshotDir, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('skips a snapshot a restore is reading and still prunes the rest (#10898)', async () => {
      const fsp = await actualFs();
      const { restoreSnapshot } = await import('./backup.js');
      const reading = await seedSnapshot(machineHost, '2020-01-01T00-00-00');
      await fsp.writeFile(joinPath(reading, 'manifest.json'), JSON.stringify({ generatedAt: '2020-01-01T00:00:00.000Z', fileCount: 0, files: {} }));
      const idle = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2020-01-02T00:00:00.000Z' });

      const restoreRsync = fakeProc();
      const backupRsync = fakeProc();
      spawn.mockReturnValueOnce(restoreRsync).mockReturnValueOnce(backupRsync);
      const restoring = restoreSnapshot(destRoot, '2020-01-01T00-00-00', { dryRun: true });
      await waitFor(() => spawn.mock.calls.length === 1, 'restore rsync spawn');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = runBackup(destRoot, recordingOperatorIo(), { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 2, 'backup rsync spawn');
      backupRsync.emit('close', 0);

      await expect(pending).resolves.toMatchObject({ status: 'ok', prunedSnapshots: 1 });
      await expect(fsp.stat(idle)).rejects.toThrow();
      await expect(fsp.stat(reading)).resolves.toBeDefined();
      expect(warn).toHaveBeenCalledWith('⚠️ Backup retention: skipped snapshot 2020-01-01T00-00-00 (SNAPSHOT_IN_USE)');

      restoreRsync.emit('close', 0);
      await expect(restoring).resolves.toMatchObject({ dryRun: true, verification: { status: 'verified' } });
    });

    it('keeps tolerating live source files that vanish mid-backup (rsync exit 24)', async () => {
      const rsync = fakeProc();
      spawn.mockReturnValue(rsync);
      const pending = runBackup(destRoot, recordingOperatorIo());
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 24);

      await expect(pending).resolves.toMatchObject({ status: 'ok' });
    });

    it('still prunes when the explicit file-backend dump is skipped', async () => {
      const fsp = await actualFs();
      const old = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const rsync = fakeProc();
      spawn.mockReturnValue(rsync);
      const pending = runBackup(destRoot, recordingOperatorIo(), { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);

      const result = await pending;
      expect(result).toMatchObject({ status: 'ok', pgBackup: { status: 'skipped' }, prunedSnapshots: 1 });
      await expect(fsp.stat(old)).rejects.toThrow();
    });

    it('retains the readable snapshot budget in addition to corrupt manifests (#12340)', async () => {
      const fsp = await actualFs();
      const oldest = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const readable = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2099-01-01T00:00:00.000Z' });
      const corrupt = await seedSnapshot(machineHost, '2020-01-03T00-00-00');
      await fsp.writeFile(joinPath(corrupt, 'manifest.json'), '{truncated');
      const unreadable = await seedSnapshot(machineHost, '2019-12-31T00-00-00');
      await fsp.writeFile(joinPath(unreadable, 'manifest.json'), '{truncated');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const rsync = fakeProc();
      spawn.mockReturnValue(rsync);
      const pending = runBackup(destRoot, recordingOperatorIo(), { retentionCount: 2 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);
      const result = await pending;
      expect(result).toMatchObject({ status: 'ok', prunedSnapshots: 1 });

      await expect(fsp.stat(oldest)).rejects.toThrow();
      await expect(fsp.stat(readable)).resolves.toBeDefined();
      await expect(fsp.stat(joinPath(destRoot, 'snapshots', machineHost, result.snapshotId))).resolves.toBeDefined();
      await expect(fsp.stat(corrupt)).resolves.toBeDefined();
      await expect(fsp.stat(unreadable)).resolves.toBeDefined();
      expect(warn).toHaveBeenCalledWith('⚠️ Backup retention: kept snapshot 2019-12-31T00-00-00 (manifest unreadable or invalid)');
    });

    it('keeps a completed backup after clock correction when a future snapshot manifest cannot be read (#12340)', async () => {
      const fsp = await actualFs();
      const future = await seedSnapshot(machineHost, '2099-01-01T00-00-00', { generatedAt: '2099-01-01T00:00:00.000Z' });
      const manifestPath = joinPath(future, 'manifest.json');
      fs.readFile.mockImplementation((path, ...args) => path === manifestPath
        ? Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
        : fsp.readFile(path, ...args));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
      try {
        const rsync = fakeProc();
        spawn.mockReturnValue(rsync);
        const pending = runBackup(destRoot, null, { retentionCount: 1 });
        await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
        rsync.emit('close', 0);
        const result = await pending;
        expect(result).toMatchObject({ status: 'ok', prunedSnapshots: 0 });
        await expect(fsp.stat(joinPath(destRoot, 'snapshots', machineHost, result.snapshotId))).resolves.toBeDefined();
        await expect(fsp.stat(future)).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith('⚠️ Backup retention: kept snapshot 2099-01-01T00-00-00 (manifest unreadable or invalid)');
      } finally {
        vi.useRealTimers();
      }
    });

    it('excludes every invalid manifest shape from a successful dump retention budget (#12396)', async () => {
      const fsp = await actualFs();
      const valid = { generatedAt: '2099-01-01T00:00:00Z', fileCount: 0, files: {} };
      const invalid = [null, [], {}, { ...valid, generatedAt: {} }, { ...valid, fileCount: 1 },
        { ...valid, fileCount: 1, files: { '../escape': 'a'.repeat(64) } },
        { ...valid, fileCount: 1, files: { 'record.json': 'bad-hash' } }];
      const protectedIds = [];
      for (const [index, manifest] of invalid.entries()) {
        const id = `2099-01-0${index + 1}T00-00-00`;
        const dir = await seedSnapshot(machineHost, id);
        await fsp.writeFile(joinPath(dir, 'manifest.json'), JSON.stringify(manifest));
        protectedIds.push(id);
        await expect(restoreSnapshot(destRoot, id, { dryRun: true }))
          .rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' });
      }
      const legacy = await seedSnapshot(machineHost, '2019-01-01T00-00-00', { dump: true });
      const healthy = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: valid.generatedAt, dump: true });
      delete process.env.MEMORY_BACKEND;
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
      getBackendName.mockReturnValue('postgres');
      const rsync = fakeProc();
      const dump = fakeProc();
      spawn.mockReturnValueOnce(rsync).mockReturnValueOnce(dump);
      const pending = runBackup(destRoot, null, { retentionCount: 1 });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      rsync.emit('close', 0);
      await waitFor(() => spawn.mock.calls.length === 2, 'pg_dump spawn');
      const args = spawn.mock.calls[1][1];
      await fsp.writeFile(args[args.indexOf('-f') + 1], COMPLETE_DUMP);
      dump.emit('close', 0);
      const result = await pending;
      expect(result).toMatchObject({ status: 'ok', pgBackup: { status: 'ok' }, prunedSnapshots: 2 });
      for (const id of [...protectedIds, result.snapshotId]) {
        await expect(fsp.stat(joinPath(destRoot, 'snapshots', machineHost, id))).resolves.toBeDefined();
      }
      await expect(fsp.stat(legacy)).rejects.toThrow();
      await expect(fsp.stat(healthy)).rejects.toThrow();
    });

    it('does not prune anything when retentionCount is null (unlimited — the legacy/unset default)', async () => {
      const fsp = await actualFs();
      const old1 = await seedSnapshot(machineHost, '2020-01-01T00-00-00', { generatedAt: '2020-01-01T00:00:00.000Z' });
      const old2 = await seedSnapshot(machineHost, '2020-01-02T00-00-00', { generatedAt: '2020-01-02T00:00:00.000Z' });

      const io = recordingOperatorIo();
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = runBackup(destRoot, io, { retentionCount: null });
      await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
      proc.emit('close', 0);
      await pending;

      await expect(fsp.stat(old1)).resolves.toBeDefined();
      await expect(fsp.stat(old2)).resolves.toBeDefined();
    });
  });

});
