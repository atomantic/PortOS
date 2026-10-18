import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: spawnMock,
}));
vi.mock('./history.js', () => ({ logAction: vi.fn() }));

import { logAction } from './history.js';
import { executeCommand, stopCommand, STOP_GRACE_MS } from './commands.js';

// A child that only dies when the caller says so: `kill` records the signal
// and the test decides when `close` fires, which is exactly the shape of an
// npm wrapper or docker compose ignoring SIGTERM (#12021).
function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe('executeCommand stop and timeout lifecycle (#12021)', () => {
  let warn;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock.mockReset();
    logAction.mockReset();
  });
  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('keeps a stopped command active through the SIGTERM grace, escalates to SIGKILL, and retires it only on close', () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const onComplete = vi.fn();
    const id = executeCommand('pwd', null, null, onComplete);

    expect(stopCommand(id)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // A second stop during the grace window is a no-op, not "not active".
    expect(stopCommand(id)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored SIGTERM'));
    expect(onComplete).not.toHaveBeenCalled();

    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      success: false, exitCode: null, signal: 'SIGKILL', stopped: true, error: 'Stopped (SIGKILL)',
    }));
    expect(logAction).toHaveBeenCalledWith('command', null, 'pwd', expect.objectContaining({ signal: 'SIGKILL' }), false, 'Stopped (SIGKILL)');
    expect(stopCommand(id)).toBe(false);
  });

  it('cancels the escalation when the child honours SIGTERM inside the grace window', () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const onComplete = vi.fn();
    const id = executeCommand('pwd', null, null, onComplete);

    stopCommand(id);
    child.signalCode = 'SIGTERM';
    child.emit('close', null, 'SIGTERM');
    vi.advanceTimersByTime(STOP_GRACE_MS * 2);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds a run with timeoutMs through the same stop path and reports timedOut', () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const onComplete = vi.fn();
    executeCommand('pwd', null, null, onComplete, { timeoutMs: 1000 });

    vi.advanceTimersByTime(999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      success: false, timedOut: true, stopped: true, error: 'Timed out after 1000ms',
    }));
  });

  it('runs unbounded by default and clears a pending timeout when the command exits on its own', () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const onComplete = vi.fn();
    executeCommand('pwd', null, null, onComplete, { timeoutMs: 1000 });
    child.exitCode = 0;
    child.emit('close', 0, null);
    vi.advanceTimersByTime(5000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true, exitCode: 0 }));
    expect(onComplete.mock.calls[0][0]).not.toHaveProperty('error');

    const unbounded = createChild();
    spawnMock.mockReturnValue(unbounded);
    executeCommand('pwd', null, null, vi.fn());
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(unbounded.kill).not.toHaveBeenCalled();
  });
});
