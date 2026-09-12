import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('./childProcess.js', () => ({
  spawn: vi.fn()
}));

import { spawn } from './childProcess.js';
import { execGit, execGitSafe } from './execGit.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('execGit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes args, cwd, and shell:false to spawn', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['status'], '/repo');
    child.emit('close', 0);
    await promise;
    expect(spawn).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({
      cwd: '/repo',
      shell: false
    }));
  });

  it('resolves with stdout/stderr/exitCode on successful exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['log'], '/repo');
    child.stdout.emit('data', Buffer.from('commit-hash'));
    child.stderr.emit('data', Buffer.from(''));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({
      stdout: 'commit-hash',
      stderr: '',
      exitCode: 0
    });
  });

  it('rejects with stderr on a non-zero exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['bogus'], '/repo');
    child.stderr.emit('data', Buffer.from('not a git command'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/not a git command/);
  });

  it('resolves on non-zero exit when ignoreExitCode is true', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['diff', '--exit-code'], '/repo', { ignoreExitCode: true });
    child.stdout.emit('data', Buffer.from('diff content'));
    child.emit('close', 1);
    await expect(promise).resolves.toEqual({
      stdout: 'diff content',
      stderr: '',
      exitCode: 1
    });
  });

  it('preserves signal termination and partial output when ignoring exit codes', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['ls-remote'], '/repo', { ignoreExitCode: true });
    child.stdout.emit('data', 'partial');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toEqual({
      stdout: 'partial', stderr: '', exitCode: null, signal: 'SIGTERM', terminated: true
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a signal exit with cancellation metadata', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['fetch'], '/repo');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError', message: 'git command cancelled by SIGTERM', signal: 'SIGTERM', terminated: true
    });
  });

  it('rejects with a timeout error and kills the child after the timeout', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['fetch'], '/repo', { timeout: 500 });
    vi.advanceTimersByTime(500);
    await expect(promise).rejects.toThrow(/timed out after 0\.5s/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('execGitSafe converts a timeout into a complete failed result even with ignoreExitCode', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGitSafe(['fetch'], '/repo', { timeout: 500, ignoreExitCode: true });
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'git command timed out after 0.5s: git fetch'
    });
  });

  it('rejects when output exceeds maxBuffer', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['log'], '/repo', { maxBuffer: 8 });
    child.stdout.emit('data', Buffer.from('a'.repeat(9)));
    await expect(promise).rejects.toThrow(/maxBuffer/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects on child spawn error', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['status'], '/repo');
    child.emit('error', new Error('spawn ENOENT'));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it('falls back to a generic error message when stderr is empty on non-zero exit', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGit(['x'], '/repo');
    child.emit('close', 2);
    await expect(promise).rejects.toThrow(/exited with code 2/);
  });
});

