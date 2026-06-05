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
}));

import { EventEmitter } from 'events';
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

import { checkHealth } from '../lib/db.js';
import * as fs from 'fs/promises';
import { DEFAULT_EXCLUDES, computeEffectiveExcludes } from './backup.js';

// Helper: build a fake child process whose close/error we can drive.
function fakeProc() {
  const proc = new EventEmitter();
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
});

describe('dumpPostgres status classification', () => {
  let dumpPostgres;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ dumpPostgres } = await import('./backup.js'));
  });

  it('returns skipped/not_configured when PG is not connected', async () => {
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns skipped/not_configured when connected but no schema', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const result = await dumpPostgres('/tmp/x.sql');
    expect(result.status).toBe('skipped');
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
