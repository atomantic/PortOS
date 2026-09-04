/**
 * Unit tests for the backup service.
 *
 * - computeEffectiveExcludes — the pure function that decides which paths
 *   rsync sees as `--exclude`. Tests the defensive Array.isArray guards
 *   (settings.json is hand-editable, so a non-array value must not throw)
 *   and the overridable allow-list (non-overridable defaults can never be
 *   disabled by user input).
 * - dumpPostgres — status classification (ok / skipped / failed) so the
 *   caller can distinguish "no PG configured" from "configured but the dump
 *   failed", including the empty-dump verification path.
 * - getState / saveState — the persisted backup-state read-merge-write cycle:
 *   default-state recovery when state.json is missing or corrupted, patch
 *   merging, and the createFileWriteQueue serialization that keeps two
 *   concurrent saveState() callers from clobbering each other's fields.
 * - restoreSnapshot — the input guards (snapshotId allow-list + traversal
 *   check, subdirFilter allow-list) and the exact rsync argument array a
 *   subdirFilter produces, plus the live-restore-only settings cache re-sync.
 *   A restore overwrites the user's live data/, so a broken filter chain or a
 *   skipped reloadSettings() is a data/consistency bug, not cosmetics.
 * - runBackup — the lifecycle itself (#3915): snapshot layout, rsync argv,
 *   manifest + state persistence, socket emissions, the isRunning re-entrancy
 *   guard, and the error path that must release the lock and record the failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join as joinPath } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// runBackup persists state to PATHS.data/backup/state.json. Re-root PATHS at
// a temp tree so the suite can never write into the live install's data dir.
var TEST_DATA_ROOT;
function testDataRoot() {
  if (!TEST_DATA_ROOT) TEST_DATA_ROOT = mkdtempSync(joinPath(tmpdir(), 'portos-backup-data-'));
  return TEST_DATA_ROOT;
}
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: testDataRoot }));

afterAll(() => {
  if (TEST_DATA_ROOT) rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});


// Mock the DB health check and child_process.spawn before importing backup.js
vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn(),
  // Default to null (version unknown) so dumpPostgres keeps the bare-`pg_dump`
  // path and the existing status tests don't trigger live binary discovery.
  getServerMajorVersion: vi.fn(() => null),
}));

// Mock the memory-backend resolver so dumpPostgres can tell whether Postgres is
// the ACTIVE backend (explicit or auto-detected) when the DB is unreachable.
vi.mock('./memoryBackend.js', () => ({
  getBackendName: vi.fn(() => null),
}));

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { PassThrough } from 'node:stream';
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
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile), access: vi.fn(actual.access) };
});

import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { getBackendName } from './memoryBackend.js';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import * as fs from 'fs/promises';
// Partial mock of the settings service: only reloadSettings is overridden, so a
// live restore can be asserted to re-sync the settings caches without actually
// touching the developer's settings.json or emitting socket events.
vi.mock('./settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reloadSettings: vi.fn(async () => {}),
}));
vi.mock('./brainStorage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invalidateAllCaches: vi.fn(),
}));
import { reloadSettings } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';
import { DEFAULT_EXCLUDES, computeEffectiveExcludes, listSnapshots, openSnapshotStream, restoreSnapshot } from './backup.js';

// fs.access is mocked file-wide because backup.js probes the .in-progress marker
// with it. Restore the real implementation before EVERY test: vi.clearAllMocks()
// resets call history but NOT implementations, so a single test's
// mockResolvedValue would otherwise make every later test see a marker and 409.
beforeEach(async () => {
  const actual = await vi.importActual('fs/promises');
  fs.access.mockImplementation(actual.access);
});

// Mirrors backup.js's MACHINE_HOST derivation so expected paths can be built
// without hardcoding this machine's hostname.
const machineHost = hostname().toLowerCase().replace(/[^\w.\-]/g, '_') || 'unknown';

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
const flush = () => vi.waitFor(() => expect(spawn).toHaveBeenCalled());

const overridable = DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path);
const nonOverridable = DEFAULT_EXCLUDES.filter(e => !e.overridable).map(e => e.path);

describe('DEFAULT_EXCLUDES anchoring', () => {
  // These are rsync FILTER patterns, not globs: an unanchored pattern matches at
  // ANY depth, so `model.obj` would drop a file of that name anywhere under data/.
  // That is a silent data-loss bug rather than a style nit, which is why it gets a
  // test rather than a convention.
  it('anchors every default exclude at the data root', () => {
    const unanchored = DEFAULT_EXCLUDES.filter((e) => !e.path.startsWith('/'));
    expect(unanchored.map((e) => e.path)).toEqual([]);
  });

  it('gives every default exclude a reason a user can act on', () => {
    // The reason string is surfaced in the backup UI; a blank one makes an
    // overridable exclude undecidable for whoever is looking at the toggle.
    for (const entry of DEFAULT_EXCLUDES) {
      expect(entry.reason, entry.path).toBeTruthy();
      expect(typeof entry.overridable, entry.path).toBe('boolean');
    }
  });

  it('excludes the TRELLIS.2 full-resolution mesh sidecar, overridably', () => {
    // ~1 GB per render of a file PortOS never serves. Overridable because it is
    // the only copy of the geometry the bake decimation discards.
    const entry = DEFAULT_EXCLUDES.find((e) => e.path === '/image-to-3d/*/model.obj');
    expect(entry).toBeDefined();
    expect(entry.overridable).toBe(true);
    // Scoped to the sidecar only — the served GLB and keyed source stay backed up.
    const paths = DEFAULT_EXCLUDES.map((e) => e.path);
    expect(paths).not.toContain('/image-to-3d/');
    expect(paths.some((x) => x.includes('model.glb'))).toBe(false);
  });
});

describe('computeEffectiveExcludes', () => {
  it('includes every DEFAULT_EXCLUDES path when nothing is disabled', () => {
    const result = computeEffectiveExcludes({ excludePaths: [], disabledDefaultExcludes: [] });
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('honors disabling an overridable default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).not.toContain(target);
  });

  it('ignores attempts to disable a non-overridable default', () => {
    const target = nonOverridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).toContain(target);
  });

  it('merges user excludePaths on top of active defaults', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['my/custom/path', 'cache/'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('my/custom/path');
    expect(result).toContain('cache/');
  });

  it('dedupes when a user exclude matches an active default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [target],
      disabledDefaultExcludes: []
    });
    expect(result.filter(p => p === target)).toHaveLength(1);
  });

  it('drops falsy entries from excludePaths', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['', null, undefined, 'real/path'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('real/path');
    expect(result).not.toContain('');
    expect(result).not.toContain(null);
  });

  it('tolerates a non-array disabledDefaultExcludes without throwing', () => {
    // Simulates a hand-edited settings.json with bad shape — should not crash.
    expect(() => computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: 'loras/*.safetensors'
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: { bogus: true }
    });
    // Bogus value is ignored — all defaults stay active.
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('tolerates a non-array excludePaths without throwing', () => {
    expect(() => computeEffectiveExcludes({
      excludePaths: 'just/one/string',
      disabledDefaultExcludes: []
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: null,
      disabledDefaultExcludes: []
    });
    // Null user list is treated as empty — only defaults remain.
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });

  it('handles being called with no arguments (defensive)', () => {
    expect(() => computeEffectiveExcludes()).not.toThrow();
    const result = computeEffectiveExcludes();
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });

  it('does NOT exclude legacy file→DB migration artifacts (they are the recovery source while a prune is blocked)', () => {
    // The boot-time prune deletes these on disk once the DB is authoritative;
    // excluding them from snapshots would strip the only recovery source during
    // a blocked (wiped/partial-restore) prune, while pg_dump captures the
    // incomplete DB. So none of these patterns may appear in the default set.
    const mustNotExclude = ['/*.imported', '/*.bak-034', '/*.migrated.json', '/writers-room/works/*/manifest.imported.json'];
    const paths = DEFAULT_EXCLUDES.map(e => e.path);
    for (const p of mustNotExclude) {
      expect(paths, `${p} must NOT be a default exclude`).not.toContain(p);
    }
  });
});

describe('listSnapshots', () => {
  beforeEach(() => vi.clearAllMocks());
  const dirent = (name, isDir) => ({ name, isDirectory: () => isDir });

  it('skips non-directory entries like .DS_Store (iCloud/Finder droppings)', async () => {
    // The backup target is commonly an iCloud folder; macOS drops a `.DS_Store`
    // FILE into every dir. It must not be treated as a snapshot id (reading
    // `<.DS_Store>/manifest.json` would throw ENOTDIR).
    vi.spyOn(fs, 'readdir').mockResolvedValue([
      dirent('.DS_Store', false),
      dirent('2026-06-08T15-18-34', true),
      dirent('2026-06-07T09-00-00', true),
    ]);
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
      if (String(p).includes('.DS_Store')) throw new Error('ENOTDIR — .DS_Store should never be read');
      return JSON.stringify({ generatedAt: '2026-06-08T00:00:00Z', fileCount: 10 });
    });
    const result = await listSnapshots('/dest');
    const ids = result.map(s => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('2026-06-08T15-18-34');
    expect(ids).not.toContain('.DS_Store');
  });

  it('returns [] for a falsy destPath without touching the filesystem', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdir');
    expect(await listSnapshots('')).toEqual([]);
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});

describe('openSnapshotStream', () => {
  afterEach(async () => {
    const actual = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(actual.stat);
    fs.access.mockImplementation(actual.access);
    spawn.mockReset();
  });

  beforeEach(() => {
    fs.access.mockRejectedValue(new Error('ENOENT'));
  });

  // An existing, COMPLETE snapshot directory, ready for tar: the directory stats
  // fine while the .in-progress marker is absent.
  function readySnapshot() {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.access.mockRejectedValue(new Error('ENOENT'));   // no .in-progress marker
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    return proc;
  }

  // Same directory, but a marker left behind by a crashed run.
  function crashedSnapshot() {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.access.mockResolvedValue(undefined);             // .in-progress present
  }

  const ended = (stream) => new Promise((resolveEnd) => stream.once('end', resolveEnd));
  const errored = (stream) => new Promise((resolveError) => stream.once('error', resolveError));

  it.each([
    ['a slash', 'snap/id'],
    ['a wildcard', 'snap*id'],
    ['a traversal id', '..'],
  ])('rejects %s before touching the disk or spawning tar', async (_label, snapshotId) => {
    await expect(openSnapshotStream('/dest', snapshotId))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('refuses a snapshot whose .in-progress marker survived a crash', async () => {
    // activeSnapshotId is module state and resets on restart; the marker is what
    // still says "this tree was never finished" after PM2 restarts mid-backup.
    crashedSnapshot();

    await expect(openSnapshotStream('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown snapshot without spawning tar', async () => {
    fs.stat.mockRejectedValue(new Error('ENOENT'));

    await expect(openSnapshotStream('/dest', 'snap-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns tar with the snapshot directory as its archive root', async () => {
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');

    expect(spawn).toHaveBeenCalledWith(
      'tar',
      ['-czf', '-', '-C', resolve(join('/dest', 'snapshots', machineHost)), 'snap-1'],
      { shell: false },
    );
    const done = ended(stream);
    stream.resume();
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('archives a legacy pre-manifest snapshot without consulting a manifest', async () => {
    // listSnapshots deliberately keeps snapshots taken before manifests existed,
    // so a missing manifest.json must never gate the download.
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'legacy-snapshot');

    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.stat.mock.calls.flat().join(' ')).not.toContain('manifest.json');
    const done = ended(stream);
    stream.resume();
    proc.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('fails the archive stream when tar exits unsuccessfully, reporting its stderr', async () => {
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    const failed = errored(stream);
    proc.stderr.emit('data', Buffer.from('tar: Permission denied'));
    proc.emit('close', 2);

    await expect(failed).resolves.toMatchObject({
      message: 'tar exited with code 2: tar: Permission denied',
    });
  });

  it('escalates the kill when the response disconnects', async () => {
    vi.useFakeTimers();
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    const failed = errored(stream);
    stream.abort();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    // A tar wedged on a stalled mount ignores SIGTERM. The escalation must still
    // fire after the grace window — it is gated on the CHILD's exit state, not on
    // the archive stream's, which abort() has already settled by this point.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();

    await expect(failed).resolves.toMatchObject({ message: 'Snapshot download aborted: snap-1' });
  });

  it('does not escalate once tar has already exited', async () => {
    vi.useFakeTimers();
    const proc = readySnapshot();

    const stream = await openSnapshotStream('/dest', 'snap-1');
    stream.on('error', () => {});
    proc.exitCode = 0;
    stream.abort();

    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('dumpPostgres status classification', () => {
  let dumpPostgres;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ dumpPostgres } = await import('./backup.js'));
  });

  it('returns skipped/not_configured when PG is down and the backend resolved to file (escape hatch)', async () => {
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue('file'); // dev/test escape hatch resolved to file
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG is down, env unset, and backend not yet initialized (null)', async () => {
    // Post-mandatory-Postgres contract: a default install whose memory backend
    // hasn't initialized yet (getBackendName() === null) still REQUIRES Postgres.
    // A DB outage before the first memory access must degrade the backup, not
    // read as a benign "not configured" skip.
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue(null);
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG is required (MEMORY_BACKEND=postgres) but down', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'postgres';
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when PG was auto-detected (MEMORY_BACKEND unset) but is down at backup time', async () => {
    // Regression: in the common default config PortOS auto-detects Postgres as
    // the active backend at startup. A later DB outage must degrade the backup,
    // not read as a benign "not configured" skip — otherwise a green backup
    // silently omits everything that lives in Postgres.
    const prev = process.env.MEMORY_BACKEND;
    delete process.env.MEMORY_BACKEND;
    getBackendName.mockReturnValue('postgres'); // resolved backend at startup
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns skipped/not_configured in explicit file mode even if a stale backend name says postgres', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'file';
    getBackendName.mockReturnValue('postgres'); // must be ignored — file is explicit
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
    getBackendName.mockReturnValue(null);
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_unreachable when connected but schema missing and PG required', async () => {
    // Post-mandatory-Postgres: a reachable-but-uninitialized DB on a non-file
    // install is a real backup failure (required schema/data not capturable),
    // not a benign skip.
    getBackendName.mockReturnValue(null);
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_unreachable');
  });

  it('returns skipped/not_configured when connected but no schema in file escape-hatch mode', async () => {
    const prev = process.env.MEMORY_BACKEND;
    process.env.MEMORY_BACKEND = 'file';
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not_configured');
    if (prev === undefined) delete process.env.MEMORY_BACKEND; else process.env.MEMORY_BACKEND = prev;
  });

  it('returns failed/pg_dump_missing when spawn errors', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('error', new Error('spawn pg_dump ENOENT'));
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('pg_dump_missing');
  });

  it('returns failed/dump_error on non-zero exit', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.stderr.emit('data', Buffer.from('FATAL: auth failed'));
    proc.emit('close', 1);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('dump_error');
    expect(result.error).toContain('auth failed');
  });

  it('honors the PORTOS_PGDUMP override outright, even when the server version is known', async () => {
    // Escape hatch: an explicit override must win over auto-discovery's
    // closest-major selection, not be funneled through it (a known server
    // version triggers resolvePgDump, which is where the override short-circuits).
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    getServerMajorVersion.mockResolvedValue(17);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE memories (...);\n');
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    try {
      const p = dumpPostgres('/tmp/x.sql');
      await flush();
      proc.emit('close', 0);
      await p;
      expect(spawn).toHaveBeenCalledWith('/custom/bin/pg_dump', expect.any(Array), expect.any(Object));
    } finally {
      delete process.env.PORTOS_PGDUMP;
      // clearAllMocks() doesn't reset implementations — restore the null default
      // so later tests keep the bare-pg_dump path (no live binary discovery).
      getServerMajorVersion.mockResolvedValue(null);
    }
  });

  it('honors the PORTOS_PGDUMP override even when the server version is unknown (detection failed)', async () => {
    // The override is the documented escape hatch for exactly this case — when
    // getServerMajorVersion() returns null, dumpPostgres must still use the
    // override instead of falling back to bare pg_dump.
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    getServerMajorVersion.mockResolvedValue(null);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE memories (...);\n');
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    try {
      const p = dumpPostgres('/tmp/x.sql');
      await flush();
      proc.emit('close', 0);
      await p;
      expect(spawn).toHaveBeenCalledWith('/custom/bin/pg_dump', expect.any(Array), expect.any(Object));
    } finally {
      delete process.env.PORTOS_PGDUMP;
    }
  });

  it('classifies a "server version mismatch" stderr as failed/version_mismatch, not dump_error', async () => {
    // Even with the server version unknown (default mock → bare pg_dump), the
    // stderr regex must reclassify pg_dump's own mismatch error so the UI can
    // point at "install a newer pg_dump" instead of the generic hint.
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.stderr.emit('data', Buffer.from(
      'pg_dump: error: aborting because of server version mismatch\n' +
      'pg_dump: detail: server version: 17.10; pg_dump version: 15.18'
    ));
    proc.emit('close', 1);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('version_mismatch');
    expect(result.error).toContain('server version mismatch');
  });

  it('unlinks the partial dump file on non-zero exit (no restorable artifact left behind)', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 1);
    await p;
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/x.sql');
  });

  it('returns failed/empty_dump when exit 0 but file is 0 bytes', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 0 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('');
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('empty_dump');
  });

  it('returns ok with sizeBytes and tableCount on a good dump', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 2048 });
    vi.spyOn(fs, 'readFile').mockResolvedValue(
      'CREATE TABLE memories (...);\nCREATE TABLE memory_links (...);\n'
    );
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = dumpPostgres('/tmp/x.sql');
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result.status).toBe('ok');
    expect(result.sizeBytes).toBe(2048);
    expect(result.tableCount).toBe(2);
  });
});

describe('restorePostgres', () => {
  let restorePostgres;
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks does not undo stubEnv — a PGPASSWORD stub from a failed
    // (thrown) test would otherwise leak into every test after it.
    vi.unstubAllEnvs();
    ({ restorePostgres } = await import('./backup.js'));
  });

  it('rejects a path-traversal snapshotId', async () => {
    await expect(restorePostgres('/dest', '../../etc', { dryRun: true }))
      .rejects.toThrow(/Invalid snapshotId/);
  });

  it('returns skipped/no_dump when the sql file is absent', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('ENOENT'));
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result).toEqual({ status: 'skipped', reason: 'no_dump' });
  });

  // portos-db.sql is still being written while a backup runs. Replaying a half
  // dump into the live database is the most destructive thing this module can
  // do, so the guard has to cover it — not just download and file restore.
  it('refuses an incomplete snapshot before reading the dump', async () => {
    fs.access.mockResolvedValue(undefined);            // .in-progress present
    const statSpy = vi.spyOn(fs, 'stat');

    await expect(restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false }))
      .rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_INCOMPLETE' });
    expect(statSpy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('dry-run reports size/tableCount without spawning psql', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.dryRun).toBe(true);
    expect(result.sizeBytes).toBe(4096);
    expect(result.tableCount).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a real restore when PG is not connected', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('treats a 0-byte dump as no_dump (does not restore a truncated snapshot)', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 0, isFile: () => true });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    expect(result).toEqual({ status: 'skipped', reason: 'no_dump' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('real restore spawns psql with ON_ERROR_STOP and shell:false, returns ok on exit 0', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result).toEqual({ status: 'ok', dryRun: false, sizeBytes: 4096, tableCount: 1 });
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('psql');
    expect(args).toEqual(expect.arrayContaining(['-v', 'ON_ERROR_STOP=1', '-f']));
    expect(opts.shell).toBe(false);
  });

  it('real restore returns failed/restore_error on non-zero psql exit', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
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
  });

  // Manifest SHA-256 verification (#980). The dump is hashed in generateManifest
  // under the parent-relative key '../portos-db.sql' — these tests assert the
  // exact key, the mismatch refusal, and the backward-compat skip paths.
  //
  // sha256File reads the dump via fs.readFile (small-file path). We mock
  // readFile path-aware: manifest.json returns the manifest JSON, the dump path
  // returns the SQL bytes that sha256File hashes. The dump content here is the
  // small string 'CREATE TABLE a;' — its real sha256 is the constant below.
  const DUMP_SQL = 'CREATE TABLE a;';
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
      return DUMP_SQL;
    });
  }

  it('proceeds when the dump hash matches the manifest (match)', async () => {
    mockDumpAndManifest({ files: { '../portos-db.sql': REAL_DUMP_SHA256 } });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.dryRun).toBe(true);
    expect(result.tableCount).toBe(1);
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
    expect(result.tableCount).toBe(1);
  });

  it('skips verification when the manifest lacks the dump key (pre-#976 manifest)', async () => {
    mockDumpAndManifest({ files: { 'instances.json': 'abc123' } });
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.tableCount).toBe(1);
  });

  // A manifest.json that is PRESENT but unparseable reads the same as absent:
  // readJSONFile returns its `null` default, so there is no expected hash to
  // compare against and verification is skipped rather than hard-failing.
  // Pinning that here so a future "throw on corrupt manifest" change is a
  // deliberate decision instead of a silent behavior swap.
  it('skips verification (does not throw) when manifest.json is malformed JSON', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: DUMP_SQL.length, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => (
      String(p).endsWith('manifest.json') ? '{ "files": { ' : DUMP_SQL
    ));
    const result = await restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: true });
    expect(result).toEqual({ status: 'ok', dryRun: true, sizeBytes: DUMP_SQL.length, tableCount: 1 });
  });

  // A malformed manifest must not become a free pass for a real restore either:
  // the replay still happens (verification skipped), so assert it reaches psql
  // rather than silently returning skipped.
  it('still runs a real restore when manifest.json is malformed JSON', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: DUMP_SQL.length, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p) => (
      String(p).endsWith('manifest.json') ? 'not json at all' : DUMP_SQL
    ));
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    const result = await p;
    expect(result.status).toBe('ok');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // psql missing from the host (ENOENT) surfaces as a spawn 'error' event, not a
  // 'close'. Without the error listener the promise would never settle and the
  // restore UI would hang forever — assert it resolves as a structured failure.
  it('resolves failed/restore_error when the psql spawn emits an error event', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
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

  // The atomicity contract: ON_ERROR_STOP=1 aborts on the first failed statement
  // and --single-transaction rolls the whole replay back, so a failed restore
  // leaves the live DB untouched instead of half-dropped. Both flags are load
  // bearing — a refactor that drops either turns a failed restore into data loss.
  it('passes --single-transaction and ON_ERROR_STOP=1 with the default PGPASSWORD', async () => {
    vi.stubEnv('PGPASSWORD', '');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
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
    expect(opts.env.PGPASSWORD).toBe('portos');
  });

  it('prefers an explicit PGPASSWORD over the portos default', async () => {
    vi.stubEnv('PGPASSWORD', 'from-env');
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 4096, isFile: () => true });
    vi.spyOn(fs, 'readFile').mockResolvedValue('CREATE TABLE a (...);\n');
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const p = restorePostgres('/dest', '2026-06-05T00-00-00', { dryRun: false });
    await flush();
    proc.emit('close', 0);
    await p;
    expect(spawn.mock.calls[0][2].env.PGPASSWORD).toBe('from-env');
  });
});

describe('runBackup pg status propagation', () => {
  let backup;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('maps dumpPostgres failed -> overall status degraded', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'failed', reason: 'dump_error' })).toBe('degraded');
  });

  it('maps dumpPostgres skipped -> overall status ok', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'skipped', reason: 'not_configured' })).toBe('ok');
  });

  it('maps dumpPostgres ok -> overall status ok', async () => {
    const { backupStatusForPg } = await import('./backup.js');
    expect(backupStatusForPg({ status: 'ok', sizeBytes: 10, tableCount: 1 })).toBe('ok');
  });
});

describe('generateManifest', () => {
  // Regression: the manifest write used a bare `writeFile` that was never
  // imported, so every real backup threw `writeFile is not defined` at the
  // very end of generateManifest. This exercises the actual write path
  // (atomicWrite) end-to-end against a real temp dir so a missing import
  // can never silently reappear.
  let tmpRoot;
  beforeEach(async () => {
    // Earlier suites install persistent vi.spyOn(fs, 'readdir'/'stat') mocks
    // (e.g. stat → { isFile: () => true }). Those leak into these real-
    // filesystem tests, so restore the spies AND re-point the factory-level
    // stat/readFile wrappers back at the genuine implementations.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const realFs = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(realFs.stat);
    fs.readFile.mockImplementation(realFs.readFile);
    vi.resetModules();
    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    tmpRoot = await mkdtemp(join(tmpdir(), 'portos-manifest-'));
  });

  it('writes the manifest file and returns hashes for every data file', async () => {
    const { mkdir, writeFile, readFile } = await import('fs/promises');
    const { join } = await import('path');
    const dataDir = join(tmpRoot, 'data');
    await mkdir(join(dataDir, 'sub'), { recursive: true });
    await writeFile(join(dataDir, 'a.txt'), 'hello');
    await writeFile(join(dataDir, 'sub', 'b.txt'), 'world');

    const manifestPath = join(tmpRoot, 'manifest.json');
    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, manifestPath);

    expect(manifest.fileCount).toBe(2);
    expect(manifest.files['a.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files[join('sub', 'b.txt')]).toMatch(/^[0-9a-f]{64}$/);

    // The file must actually be written (the regression was a write-time throw).
    const written = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(written).toEqual(manifest);
  });

  it('includes the parent-relative pg dump hash when a dump path is given', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const { mkdir } = await import('fs/promises');
    const dataDir = join(tmpRoot, 'data');
    await mkdir(dataDir, { recursive: true });
    const dumpPath = join(tmpRoot, 'portos-db.sql');
    await writeFile(dumpPath, 'PG DUMP');

    const { generateManifest } = await import('./backup.js');
    const manifest = await generateManifest(dataDir, join(tmpRoot, 'manifest.json'), dumpPath);

    expect(manifest.files['../portos-db.sql']).toMatch(/^[0-9a-f]{64}$/);
  });
});

// restoreSnapshot's service-side subdirFilter guard (issue #1822). These reject
// BEFORE runRsync/spawn is reached, so no fake child process is needed — an
// invalid filter must never make it into an `--include=` rsync arg.
describe('restoreSnapshot subdirFilter guard', () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it('rejects a wildcard filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '*' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a traversal filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '../escape' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an absolute-path filter before spawning rsync', async () => {
    await expect(restoreSnapshot('/dest', 'snap-1', { subdirFilter: '/etc' }))
      .rejects.toThrow(/Invalid subdirFilter/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses PORTOS_RSYNC when configured and keeps shell execution disabled', async () => {
    const previous = process.env.PORTOS_RSYNC;
    process.env.PORTOS_RSYNC = '/custom/bin/rsync';
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    try {
      const restore = restoreSnapshot('/dest', 'snap-1');
      await flush();
      proc.stdout.emit('data', Buffer.from('>f+++++++++ settings.json\n'));
      proc.emit('close', 0);

      await expect(restore).resolves.toMatchObject({
        dryRun: true,
        changedFiles: ['>f+++++++++ settings.json'],
      });
      expect(spawn).toHaveBeenCalledWith(
        '/custom/bin/rsync',
        expect.arrayContaining(['--archive', '--itemize-changes', '--dry-run']),
        { shell: false },
      );
    } finally {
      if (previous === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previous;
    }
  });

  it('falls back to the PATH-resolved rsync command when no override is configured', async () => {
    const previous = process.env.PORTOS_RSYNC;
    delete process.env.PORTOS_RSYNC;
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    try {
      const restore = restoreSnapshot('/dest', 'snap-1');
      await flush();
      proc.emit('close', 0);
      await restore;

      expect(spawn.mock.calls[0][0]).toBe('rsync');
      expect(spawn.mock.calls[0][2]).toEqual({ shell: false });
    } finally {
      if (previous === undefined) delete process.env.PORTOS_RSYNC;
      else process.env.PORTOS_RSYNC = previous;
    }
  });
});

// getState / saveState — the persisted `data/backup/state.json` read-merge-write
// cycle (issue #3916). Runs against a real temp dir with `PATHS.data` re-pointed,
// so the assertions cover the ACTUAL bytes on disk (real readJSONFile +
// atomicWrite), not a mocked persistence layer.
describe('getState and saveState', () => {
  let tmpRoot;
  let backup;
  let writeLog;

  beforeEach(async () => {
    // Same spy hygiene as the generateManifest suite: earlier suites leave
    // persistent fs spies installed, and these tests hit the real filesystem.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const realFs = await vi.importActual('fs/promises');
    fs.stat.mockImplementation(realFs.stat);
    fs.readFile.mockImplementation(realFs.readFile);
    vi.resetModules();

    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    tmpRoot = await mkdtemp(join(tmpdir(), 'portos-backup-state-'));
    writeLog = [];

    // `vi.doMock` is NOT hoisted, so the factory can close over `tmpRoot` and
    // `writeLog`. makePathsProxy rather than a hand-rolled `PATHS: { ...actual.PATHS,
    // data: tmpRoot }`: spelling one member by hand re-roots only `data`, leaving
    // every other data-derived member (`backup`'s siblings, `imageRefs`, …) aimed
    // at the live install — the #3683/#6176 partial-redirect trap. `overrides`
    // carries the atomicWrite spy, which is why this stays a doMock at all.
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return makePathsProxy(actual, {
        dataRoot: () => tmpRoot,
        overrides: {
          // Bracket the real write with log markers and a delay, so an unqueued
          // read-merge-write would visibly interleave (start/start/end/end).
          atomicWrite: async (filePath, data) => {
            writeLog.push(`start:${data?.status}`);
            await new Promise((r) => setTimeout(r, 10));
            const result = await actual.atomicWrite(filePath, data);
            writeLog.push(`end:${data?.status}`);
            return result;
          },
        },
      });
    });
    backup = await import('./backup.js');
  });

  afterEach(async () => {
    // Re-register the FILE-LEVEL redirect instead of calling `vi.doUnmock`.
    // `doUnmock` drops the hoisted `vi.mock` at the top of this file too, so
    // every suite AFTER this one resolved PATHS.data to the install's real
    // data/ tree — and `runBackup lifecycle` below then rewrote the
    // developer's genuine data/backup/state.json on every run (#6176; the
    // runtime write guard is what surfaced it).
    vi.doMock('../lib/fileUtils.js', async (importOriginal) =>
      makePathsProxy(await importOriginal(), { dataRoot: testDataRoot }));
    vi.resetModules();
    const { rm } = await import('fs/promises');
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  // Read the raw persisted state file (no service helpers) so the assertions
  // describe what a *restore* or another process would actually see.
  async function readStateFile() {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    return JSON.parse(await readFile(join(tmpRoot, 'backup', 'state.json'), 'utf-8'));
  }

  const DEFAULTS = {
    lastRun: null,
    status: 'never',
    lastSnapshotId: null,
    filesChanged: 0,
    pgBackup: null,
    error: null
  };

  it('returns the default state when state.json does not exist', async () => {
    expect(await backup.getState()).toEqual(DEFAULTS);
  });

  it('returns the default state when state.json holds invalid JSON', async () => {
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await mkdir(join(tmpRoot, 'backup'), { recursive: true });
    // Truncated mid-object — the shape a crash during a non-atomic write leaves.
    await writeFile(join(tmpRoot, 'backup', 'state.json'), '{"status":"ok","filesChanged":');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await backup.getState()).toEqual(DEFAULTS);
  });

  it('merges a patch into existing state and persists it to disk', async () => {
    await backup.saveState({ lastRun: '2026-01-01T00:00:00Z', status: 'ok', filesChanged: 7 });
    const updated = await backup.saveState({ status: 'degraded', error: 'pg dump failed' });

    // The second patch must not drop the first patch's untouched fields.
    expect(updated).toEqual({
      ...DEFAULTS,
      lastRun: '2026-01-01T00:00:00Z',
      status: 'degraded',
      filesChanged: 7,
      error: 'pg dump failed'
    });
    expect(await readStateFile()).toEqual(updated);
    // A fresh read of the file agrees with the returned value.
    expect(await backup.getState()).toEqual(updated);
  });

  it('serializes concurrent saveState calls so neither patch is clobbered', async () => {
    const [first, second] = await Promise.all([
      backup.saveState({ status: 'running', filesChanged: 10 }),
      backup.saveState({ status: 'ok', lastSnapshotId: 'snap-2' })
    ]);

    // Queue order is call order: the first write sees only its own patch...
    expect(first).toEqual({ ...DEFAULTS, status: 'running', filesChanged: 10 });
    // ...and the second reads the FIRST one's committed image, not the pre-image.
    expect(second).toEqual({
      ...DEFAULTS,
      status: 'ok',
      filesChanged: 10,
      lastSnapshotId: 'snap-2'
    });

    // No interleaving: each read-merge-write completes before the next starts.
    expect(writeLog).toEqual(['start:running', 'end:running', 'start:ok', 'end:ok']);

    // Last write wins on disk, with both patches' fields intact.
    expect(await readStateFile()).toEqual(second);
  });

  it('keeps a rejected write from poisoning the queue for later callers', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    // A pre-existing FILE where the backup dir must go makes the write throw
    // ENOTDIR, so the first saveState rejects mid-queue.
    await writeFile(join(tmpRoot, 'backup'), 'not a directory');

    await expect(backup.saveState({ status: 'running' })).rejects.toThrow();

    const { rm } = await import('fs/promises');
    await rm(join(tmpRoot, 'backup'));
    // The queue tail must still accept work after the rejection.
    const after = await backup.saveState({ status: 'ok' });
    expect(after).toEqual({ ...DEFAULTS, status: 'ok' });
    expect(await readStateFile()).toEqual(after);
  });
});

// snapshotId validation + rsync filter construction + settings cache re-sync.
// restoreSnapshot writes over the user's live data/ directory, so each of these
// is a data-loss-adjacent contract, not a style nit (issue #3917).
describe('restoreSnapshot snapshotId, filter flags, and settings re-sync', () => {
  beforeEach(() => {
    spawn.mockReset();
    reloadSettings.mockClear();
    invalidateBrainCaches.mockClear();
  });

  // Drive a mocked rsync to a clean exit so restoreSnapshot resolves.
  async function runRestore(...args) {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restoreSnapshot(...args);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    proc.emit('close', 0);
    return pending;
  }

  describe('snapshotId validation', () => {
    // Ids containing a separator fail the character allow-list outright...
    for (const bad of ['../../etc', '../escape', 'a/b', 'snap 1', 'snap;rm -rf', '']) {
      it(`rejects ${JSON.stringify(bad)} before spawning rsync`, async () => {
        await expect(restoreSnapshot('/dest', bad)).rejects.toThrow(/Invalid snapshotId/);
        expect(spawn).not.toHaveBeenCalled();
      });
    }

    // ...but `..` is made only of allow-listed characters, so it slips past the
    // regex and must be caught by the resolve()/relative() traversal check. This
    // is the bypass probe: delete that second guard and only this case fails.
    it('rejects a bare `..` that passes the character allow-list, via the traversal check', async () => {
      await expect(restoreSnapshot('/dest', '..')).rejects.toThrow(/Path traversal detected/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('accepts a timestamp-shaped id', async () => {
      await expect(runRestore('/dest', '2026-01-02T03:04:05.678Z')).resolves.toMatchObject({
        snapshotId: '2026-01-02T03:04:05.678Z',
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('subdirFilter rsync flags', () => {
    it('builds the exact include/exclude chain for a valid subdirFilter', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true, subdirFilter: 'brain' });

      const srcDir = resolve('/dest', 'snapshots', machineHost, 'snap-1', 'data');
      // Asserted as an exact array (not arrayContaining): the ORDER matters to
      // rsync — `--exclude=*` must come last, after both includes, or the
      // targeted restore silently degrades into a full-tree restore.
      // `--itemize-changes` legitimately appears twice: runRsync always prepends
      // it, and restoreSnapshot seeds its own flag list with it. Harmless to
      // rsync, and pinned here so a future de-dup is a deliberate change.
      expect(spawn.mock.calls[0][1]).toEqual([
        '--archive',
        '--itemize-changes',
        '--itemize-changes',
        '--dry-run',
        '--include=brain/***',
        '--include=*/',
        '--exclude=*',
        `${srcDir}/`,
        PATHS.data,
      ]);
    });

    it('emits no include/exclude flags when no subdirFilter is given', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true });

      const args = spawn.mock.calls[0][1];
      expect(args.filter(a => a.startsWith('--include=') || a.startsWith('--exclude='))).toEqual([]);
    });

    it('echoes the subdirFilter back in the result', async () => {
      await expect(runRestore('/dest', 'snap-1', { dryRun: true, subdirFilter: 'brain' }))
        .resolves.toMatchObject({ subdirFilter: 'brain' });
    });
  });

  describe('settings cache re-sync', () => {
    it('reloads settings after a live restore', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: false });

      expect(reloadSettings).toHaveBeenCalledTimes(1);
      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
      // A live restore must not pass --dry-run to rsync.
      expect(spawn.mock.calls[0][1]).not.toContain('--dry-run');
    });

    it('invalidates Brain projections after a nested selective live Brain restore', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter: 'brain/inbox' });

      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
    });

    it('keeps Brain projections after a selective live restore outside Brain', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter: 'images' });

      expect(invalidateBrainCaches).not.toHaveBeenCalled();
    });

    it('does not reload settings for a dry run', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true });

      expect(reloadSettings).not.toHaveBeenCalled();
      expect(invalidateBrainCaches).not.toHaveBeenCalled();
      expect(spawn.mock.calls[0][1]).toContain('--dry-run');
    });

    it('defaults to a dry run (no settings reload) when no options are given', async () => {
      await expect(runRestore('/dest', 'snap-1')).resolves.toMatchObject({ dryRun: true });

      expect(reloadSettings).not.toHaveBeenCalled();
    });

    it('does not reload settings when rsync fails a live restore', async () => {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      proc.stderr.emit('data', Buffer.from('boom'));
      proc.emit('close', 1);

      await expect(pending).rejects.toThrow(/rsync exited with code 1/);
      expect(reloadSettings).not.toHaveBeenCalled();
    });
  });
});

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
  let dataRoot;

  // Real fs bound once, bypassing the module-level fs/promises mock, so the
  // helpers below read what actually landed on disk.
  const actualFs = async () => (realFs ??= await vi.importActual('fs/promises'));

  // rsync/pg_dump are stubbed, so backup work completes via real async I/O
  // rather than on a fixed number of microtasks. Poll instead of guessing.
  async function waitFor(predicate, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
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

    destRoot = await fsp.mkdtemp(joinPath(tmpdir(), 'portos-backup-dest-'));

    // Fresh module per test: `isRunning` is module-level state, so the lock
    // tests must not inherit a previous test's value.
    vi.resetModules();
    ({ runBackup } = await import('./backup.js'));
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

  it('rsyncs, writes a manifest and state, and emits started/completed', async () => {
    const io = { emit: vi.fn() };
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
    await fsp.writeFile(joinPath(snapshotDir, 'data', 'settings.json'), '{"a":1}');

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
    expect(args.slice(0, 2)).toEqual(['--archive', '--itemize-changes']);
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

    // --- manifest ---------------------------------------------------------
    const manifest = await readJson(joinPath(snapshotDir, 'manifest.json'));
    expect(manifest.fileCount).toBe(1);
    expect(manifest.files['settings.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest).toEqual(manifest);

    // --- persisted state --------------------------------------------------
    const state = await readJson(joinPath(dataRoot, 'backup', 'state.json'));
    expect(state).toMatchObject({
      lastRun: result.lastRun,
      lastSnapshotId: result.snapshotId,
      status: 'ok',
      filesChanged: 2,
      pgBackup: SKIPPED_PG,
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
      }],
    ]);
  });

  it('returns { skipped: true } for a concurrent call without a second rsync', async () => {
    const io = { emit: vi.fn() };
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const first = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'first rsync spawn');

    // Second call while the first is mid-flight.
    const second = { emit: vi.fn() };
    await expect(runBackup(destRoot, second)).resolves.toEqual({ skipped: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(second.emit).not.toHaveBeenCalled();
    // The suppressed call must not announce a run it never started.
    expect(io.emit.mock.calls.filter(([event]) => event === 'backup:started')).toHaveLength(1);

    proc.emit('close', 0);
    await first;
  });

  // A snapshot mid-assembly would tar/rsync as a truncated tree that looks like
  // a complete backup. Driven through the real runBackup rather than a stubbed
  // marker so the guard is tested against the state that actually gates it.
  it('refuses to download or restore the snapshot currently being written', async () => {
    const io = { emit: vi.fn() };
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
    // Only the rsync — neither guard reached tar or a second rsync.
    expect(spawn).toHaveBeenCalledTimes(1);

    proc.emit('close', 0);
    await pending;
  });

  // The old on-disk '.in-progress' marker was never removed on failure, which
  // left a failed snapshot permanently un-downloadable with no recovery path.
  it('clears the in-progress guard when a run fails, leaving the snapshot downloadable', async () => {
    const io = { emit: vi.fn() };
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const { openSnapshotStream: open } = await import('./backup.js');

    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn');
    const snapshotId = io.emit.mock.calls[0][1].snapshotId;
    proc.emit('close', 23);
    await expect(pending).rejects.toThrow(/rsync exited with code 23/);

    const tar = fakeProc();
    spawn.mockReturnValue(tar);
    const stream = await open(destRoot, snapshotId);
    expect(stream).toBeDefined();
    stream.destroy();
  });

  it('on rsync failure: releases the lock, records status error, emits backup:failed, and rethrows', async () => {
    const io = { emit: vi.fn() };
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

  it('on PostgreSQL setup failure: releases the lock, records status error, and permits retry', async () => {
    const io = { emit: vi.fn() };
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

  it('rejects a missing destination before locking, spawning, or emitting', async () => {
    const io = { emit: vi.fn() };
    await expect(runBackup(joinPath(destRoot, 'does-not-exist'), io))
      .rejects.toThrow(/Backup destination not found/);
    expect(spawn).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();

    // The failed precondition must not have left the lock engaged.
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = runBackup(destRoot, io);
    await waitFor(() => spawn.mock.calls.length === 1, 'rsync spawn after bad dest');
    proc.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ status: 'ok' });
  });
});
