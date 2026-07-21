import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { execGh } from './github.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('execGh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout error and kills the child when it never closes', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'slow'], 50);
    // Suppress unhandled-rejection noise until we await below.
    promise.catch(() => {});
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow(/timed out after 50ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('resolves with trimmed stdout on a successful close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'repos'], 5000);
    child.stdout.emit('data', Buffer.from('  {"ok":true}  \n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('{"ok":true}');
  });

  it('rejects with stderr on a non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.stderr.emit('data', Buffer.from('not found'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/not found/);
  });

  it('falls back to a generic error message when stderr is empty on non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.emit('close', 7);
    await expect(promise).rejects.toThrow(/gh exited with code 7/);
  });

  it('does not fire the timeout timer on a fast normal completion', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'fast'], 5000);
    child.stdout.emit('data', Buffer.from('done'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('done');
    // Advancing well past the timeout must not reject/kill after settling.
    vi.advanceTimersByTime(10000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects on a child spawn error', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'x'], 5000);
    child.emit('error', new Error('spawn gh ENOENT'));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });
});
