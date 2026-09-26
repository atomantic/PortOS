import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _cleanupTestBrowser } from './testBrowserCleanup.js';

function child() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn(signal => {
    if (signal === 'SIGKILL') {
      proc.signalCode = signal;
      proc.emit('close', null, signal);
    }
    return true;
  });
  return proc;
}

describe('owned test Chrome cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not wait for a signal-exited child whose close event already fired', async () => {
    const proc = child();
    proc.signalCode = 'SIGTERM';
    proc.emit('close', null, 'SIGTERM');
    const cleanup = vi.fn();
    await _cleanupTestBrowser({ proc, cleanup });
    expect(proc.kill).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes synchronous termination and cancels escalation', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      proc.signalCode = signal;
      proc.emit('close', null, signal);
    });
    await _cleanupTestBrowser({ proc, cleanup: vi.fn() });
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(proc.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates an ignored SIGTERM and waits for delayed close', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') {
        proc.signalCode = signal;
        setTimeout(() => proc.emit('close', null, signal), 100);
      }
    });
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({ proc, cleanup });
    await vi.advanceTimersByTimeAsync(3000);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still terminates the child and cleans data when disconnect rejects', async () => {
    const proc = child();
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({
      browser: { close: () => Promise.reject(new Error('disconnect failed')) }, proc, cleanup,
    });
    const rejected = expect(result).rejects.toThrow('disconnect failed');
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports both deadlines and cleans data even if disconnect and child close never settle', async () => {
    const proc = child();
    proc.kill.mockImplementation(() => true);
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({
      browser: { close: () => new Promise(() => {}) }, proc, cleanup,
    });
    const rejected = expect(result).rejects.toThrow(
      'Test Chrome browser disconnect exceeded 5000ms deadline; Test Chrome child termination exceeded 10000ms deadline',
    );
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
