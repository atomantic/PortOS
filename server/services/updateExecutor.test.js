import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/mock', data: '/mock/data' }
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./updateChecker.js', () => ({
  recordUpdateResult: vi.fn().mockResolvedValue(undefined)
}));

import { spawn } from 'child_process';
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: marker file not found (tests that need it override this)
  readFile.mockRejectedValue(new Error('ENOENT'));
});

describe('executeUpdate', () => {
  it('spawns powershell on Windows', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const promise = executeUpdate('v1.0.0', () => {});
      child.emit('close', 0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'powershell',
        expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']),
        expect.any(Object)
      );
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('parses STEP markers from stdout', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const emits = [];
    const promise = executeUpdate('v1.0.0', (...args) => emits.push(args));

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
    spawn.mockReturnValue(child);

    const promise = executeUpdate('v1.0.0', () => {});
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
    spawn.mockReturnValue(child);

    const promise = executeUpdate('v1.0.0', () => {});
    child.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it('handles CRLF line endings from Windows PowerShell', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const emits = [];
    const promise = executeUpdate('v1.0.0', (...args) => emits.push(args));

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
    spawn.mockReturnValue(child);
    readFile.mockResolvedValue(JSON.stringify({ version: '2.0.0', completedAt: '2026-01-01T00:00:00Z' }));

    const promise = executeUpdate('v1.0.0', () => {});
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
    spawn.mockReturnValue(child);

    const emits = [];
    const promise = executeUpdate('v1.0.0', (...args) => emits.push(args));
    child.emit('error', new Error('spawn failed'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: 'spawn failed' })
    );
  });
});
