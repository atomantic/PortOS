import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process.spawn so we can drive the buffered-spawn machinery without
// launching real processes.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a) => spawnMock(...a) }));

// Re-imported after the mock is registered.
const {
  bufferedSpawn,
  bufferedSpawnOrThrow,
  killProcessTree,
  needsShell,
  resolveWindowsExecutable,
  IS_WIN32,
  WIN_CMD_SHIMS,
  MAX_OUTPUT_BYTES,
} = await import('./bufferedSpawn.js');

/** Build a fake child process with stdout/stderr emitters and a kill spy. */
function makeFakeChild({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  // Default: any spawn returns a fresh fake child. On a Windows test runner the
  // timeout path also spawns `taskkill` via killProcessTree — without a default
  // it would get `undefined` and crash on `.on(...)`. Tests that need to drive a
  // specific child queue it explicitly with mockReturnValueOnce.
  spawnMock.mockImplementation(() => makeFakeChild());
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('needsShell / constants', () => {
  it('only treats npm/npx as shell shims, and only on Windows', () => {
    expect(WIN_CMD_SHIMS.has('npm')).toBe(true);
    expect(WIN_CMD_SHIMS.has('npx')).toBe(true);
    expect(WIN_CMD_SHIMS.has('git')).toBe(false);
    // needsShell mirrors IS_WIN32 — false on non-Windows test runners.
    expect(needsShell('npm')).toBe(IS_WIN32);
    expect(needsShell('git')).toBe(false);
  });

  it('caps buffered output at 64KiB', () => {
    expect(MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });
});

describe('killProcessTree', () => {
  it('on non-Windows sends SIGTERM to the child', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild();
    killProcessTree(child);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('on Windows spawns taskkill /T /F against the pid and marks the child killed', () => {
    if (!IS_WIN32) return; // can't simulate platform branch from outside
    const child = makeFakeChild({ pid: 999 });
    const tk = makeFakeChild();
    tk.unref = vi.fn();
    spawnMock.mockReturnValueOnce(tk);
    killProcessTree(child);
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill', ['/T', '/F', '/PID', '999'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    );
    // taskkill runs in a detached process that never touches `child` itself —
    // .killed must be set synchronously here so re-entrant kill/abort guards
    // elsewhere (gated on `!child.killed`) actually engage on Windows.
    expect(child.killed).toBe(true);
  });
});

describe('resolveWindowsExecutable', () => {
  // isWin32 is passed explicitly so these tests are deterministic regardless
  // of the host platform actually running them.
  let fakePathDir;
  let originalPath;

  beforeEach(async () => {
    fakePathDir = await mkdtemp(join(tmpdir(), 'resolve-win-exe-'));
    originalPath = process.env.PATH;
    process.env.PATH = fakePathDir;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(fakePathDir, { recursive: true, force: true });
  });

  it('returns null when isWin32 is false, regardless of what is on PATH', async () => {
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    expect(resolveWindowsExecutable('opencode', false)).toBeNull();
  });

  it('resolves a bare command to its .cmd shim on PATH', async () => {
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    expect(resolveWindowsExecutable('opencode', true)).toBe(join(fakePathDir, 'opencode.cmd'));
  });

  it('prefers a real .exe over a .cmd shim when both exist', async () => {
    await writeFile(join(fakePathDir, 'tool.cmd'), '@echo off\n');
    await writeFile(join(fakePathDir, 'tool.exe'), '');
    expect(resolveWindowsExecutable('tool', true)).toBe(join(fakePathDir, 'tool.exe'));
  });

  it('never matches an extension-less POSIX shim stub (the actual #1865 root cause)', async () => {
    // npm ships a bare POSIX shell-script stub alongside the .cmd/.bat/.ps1
    // Windows wrappers for Git Bash/WSL — it is not natively launchable.
    await writeFile(join(fakePathDir, 'opencode'), '#!/bin/sh\n');
    expect(resolveWindowsExecutable('opencode', true)).toBeNull();
  });

  it('returns null when nothing matches on PATH', () => {
    expect(resolveWindowsExecutable('does-not-exist', true)).toBeNull();
  });

  it('returns null for an already-absolute path (nothing to resolve)', () => {
    expect(resolveWindowsExecutable('C:\\tools\\opencode.cmd', true)).toBeNull();
  });

  it('returns null for a relative path containing a separator', () => {
    expect(resolveWindowsExecutable('./bin/opencode', true)).toBeNull();
  });
});

describe('bufferedSpawn — structured result', () => {
  it('resolves success on a clean (code 0) exit and captures stdout/stderr', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('echo', ['hi'], { cwd: '/tmp' });
    child.stdout.emit('data', 'out-data');
    child.stderr.emit('data', 'err-data');
    child.emit('close', 0, null);
    const result = await p;
    expect(result).toEqual({
      success: true, code: 0, signal: null,
      stdout: 'out-data', stderr: 'err-data', timedOut: false,
    });
    // cwd + windowsHide passed through; shell defaults to needsShell(cmd).
    expect(spawnMock).toHaveBeenCalledWith('echo', ['hi'], expect.objectContaining({ cwd: '/tmp', windowsHide: true }));
  });

  it('resolves failure (not throw) on a non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('false', []);
    child.emit('close', 2, 'SIGABRT');
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.code).toBe(2);
    expect(result.signal).toBe('SIGABRT');
    expect(result.timedOut).toBe(false);
  });

  it('resolves with the error attached on a spawn error', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('nope', []);
    const err = new Error('ENOENT');
    child.emit('error', err);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.error).toBe(err);
    expect(result.timedOut).toBe(false);
  });

  it('caps stdout to MAX_OUTPUT_BYTES (keeps the tail)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('big', []);
    child.stdout.emit('data', 'a'.repeat(MAX_OUTPUT_BYTES));
    child.stdout.emit('data', 'TAIL');
    child.emit('close', 0, null);
    const result = await p;
    expect(result.stdout.length).toBe(MAX_OUTPUT_BYTES);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout.startsWith('a')).toBe(true);
  });

  it('times out: kills the tree and resolves timedOut with buffered partial output', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('hang', [], { timeoutMs: 1000 });
    child.stdout.emit('data', 'partial');
    vi.advanceTimersByTime(1000);
    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.stdout).toBe('partial');
    if (!IS_WIN32) expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('a close after timeout does not double-resolve (settled guard)', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('hang', [], { timeoutMs: 500 });
    vi.advanceTimersByTime(500);
    child.emit('close', 0, null); // late close — must be ignored
    const result = await p;
    expect(result.timedOut).toBe(true);
  });

  it('respects an explicit shell override', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('cmd', [], { shell: true });
    child.emit('close', 0, null);
    await p;
    expect(spawnMock).toHaveBeenCalledWith('cmd', [], expect.objectContaining({ shell: true }));
  });
});

describe('bufferedSpawnOrThrow — throwing adapter', () => {
  it('resolves { stdout, stderr } on a clean exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('git', ['pull'], { cwd: '/repo' });
    child.stdout.emit('data', 'Already up to date.');
    child.emit('close', 0, null);
    await expect(p).resolves.toEqual({ stdout: 'Already up to date.', stderr: '' });
  });

  it('throws the spawn error', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('nope', []);
    const err = new Error('boom');
    child.emit('error', err);
    await expect(p).rejects.toBe(err);
  });

  it('throws using stderr on a non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['install']);
    child.stderr.emit('data', '  npm ERR! failed  ');
    child.emit('close', 1, null);
    await expect(p).rejects.toThrow('npm ERR! failed');
  });

  it('throws "exited with code" when stderr is empty', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('make', []);
    child.emit('close', 7, null);
    await expect(p).rejects.toThrow('make exited with code 7');
  });

  it('throws a timeout message using the command name', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['install'], { timeoutMs: 2000 });
    const assertion = expect(p).rejects.toThrow('npm timed out after 2s');
    vi.advanceTimersByTime(2000);
    await assertion;
  });

  it('uses timeoutLabel when provided', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['run', 'setup'], { timeoutMs: 3000, timeoutLabel: 'Setup' });
    const assertion = expect(p).rejects.toThrow('Setup timed out after 3s');
    vi.advanceTimersByTime(3000);
    await assertion;
  });
});
