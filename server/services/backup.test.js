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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { spawn } from 'child_process';
// Partial mock: only override spawn. Preserve execFile et al. because
// backup.js transitively imports fileUtils.js, which promisifies execFile.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));

// Mock fs/promises so stat/readFile are spyable in ESM (the real namespace
// is non-configurable). Spread the original first so every other fs helper
// used by backup.js + fileUtils.js keeps its real implementation.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) };
});

import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { getBackendName } from './memoryBackend.js';
import * as fs from 'fs/promises';
import { DEFAULT_EXCLUDES, computeEffectiveExcludes, listSnapshots, restoreSnapshot } from './backup.js';

// Helper: build a fake child process whose close/error we can drive.
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

// dumpPostgres awaits checkHealth() before calling spawn() and attaching its
// close/error listeners. Flush the microtask queue so the listeners exist
// before the test drives the fake process — otherwise an 'error' emit throws
// (no listener) and 'close' emits fall into the void (test hangs).
const flush = () => new Promise((r) => setTimeout(r, 0));

const overridable = DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path);
const nonOverridable = DEFAULT_EXCLUDES.filter(e => !e.overridable).map(e => e.path);

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
