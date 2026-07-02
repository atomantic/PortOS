import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/mock', data: '/mock/data' }
}));

vi.mock('../lib/detachedSpawn.js', () => ({
  spawnDetached: vi.fn()
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./updateChecker.js', () => ({
  recordUpdateResult: vi.fn().mockResolvedValue(undefined)
}));

import { spawn } from 'child_process';
import { spawnDetached } from '../lib/detachedSpawn.js';
import { readFile } from 'fs/promises';
import { recordUpdateResult } from './updateChecker.js';
import { executeUpdate } from './updateExecutor.js';

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.pid = 12345;
  return child;
}

// executeUpdate awaits spawnDetached before wiring its event listeners, so
// tests must flush the microtask/immediate queue after calling it and before
// emitting child events, or the emission fires into the void.
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startUpdate(...args) {
  const promise = executeUpdate(...args);
  await flush();
  // Wrapped in an object so `await startUpdate(...)` does not flatten the
  // still-pending executeUpdate promise (which only settles after 'close').
  return { promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: marker file not found (tests that need it override this)
  readFile.mockRejectedValue(new Error('ENOENT'));
});

describe('executeUpdate', () => {
  it('spawns powershell on Windows (plain spawn, not spawnDetached)', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const { promise } = await startUpdate('v1.0.0', () => {});
      child.emit('close', 0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'powershell',
        expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']),
        expect.any(Object)
      );
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  // Regression for the reconcile "shuts down but never restarts" failure: a
  // plain spawn(detached:true) child is still a PPID-descendant of
  // portos-server, so update.sh's own `pm2 delete` tree-killed the script
  // before it could run the final `pm2 start`. POSIX must launch through
  // spawnDetached's double-fork (reparent to init) instead.
  it('launches via spawnDetached with a control dir on POSIX', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    await promise;

    expect(spawn).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('update.sh')],
      expect.objectContaining({
        cwd: '/mock',
        controlDir: expect.stringContaining('update-detached')
      })
    );
  });

  it('parses STEP markers from stdout', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate STEP output
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\n'));

    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'running')).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'done')).toBe(true);
  });

  it('records update result on success with tag fallback when marker missing', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('1.0.0');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.0.0', success: true })
    );
  });

  it('records failure on non-zero exit code', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it('handles CRLF line endings from Windows PowerShell', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate CRLF output (Windows PowerShell)
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\r\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\r\n'));

    child.emit('close', 0);
    await promise;

    // Messages should not contain trailing \r
    const pullRunning = emits.find(e => e[0] === 'git-pull' && e[1] === 'running');
    expect(pullRunning[2]).toBe('Pulling latest changes');
    expect(pullRunning[2]).not.toMatch(/\r/);
  });

  it('returns actual version from completion marker and records result on success', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    readFile.mockResolvedValue(JSON.stringify({ version: '2.0.0', completedAt: '2026-01-01T00:00:00Z' }));

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', success: true })
    );
  });

  it('handles spawn error', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    child.emit('error', new Error('spawn failed'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: 'spawn failed' })
    );
  });

  // Reconcile (issue #1779) passes the stale workspaces so update.sh force-
  // reinstalls exactly those, regardless of the commit diff.
  it('passes allowlisted forceCleanWorkspaces as PORTOS_FORCE_CLEAN_WORKSPACES', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['.', 'client'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('.,client');
  });

  it('does NOT set PORTOS_FORCE_CLEAN_WORKSPACES when none are given', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });

  it('filters out non-allowlisted workspace names (no injection)', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['client', '../../etc', 'rm -rf /'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('client');
  });

  it('does NOT set the env when every workspace name is rejected', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['bogus'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });
});
