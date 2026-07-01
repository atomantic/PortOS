import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { killWithEscalation } from './killWithEscalation.js';

// A minimal ChildProcess stand-in: exitCode/signalCode default to null (still
// running); kill() records the signal and, for SIGTERM/SIGKILL, flips the
// matching field so the escalation guard reflects a real exit.
const makeProc = () => {
  const proc = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((sig) => {
      if (sig === 'SIGKILL') proc.signalCode = 'SIGKILL';
      return true;
    }),
  };
  return proc;
};

describe('killWithEscalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends SIGTERM synchronously', () => {
    const proc = makeProc();
    killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL after the default 8s grace when still running', () => {
    const proc = makeProc();
    killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    // Not yet past the grace window.
    vi.advanceTimersByTime(7999);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenCalledTimes(2);
    expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("test job didn't exit on SIGTERM"),
    );
  });

  it('honors a custom delayMs', () => {
    const proc = makeProc();
    killWithEscalation(proc, { label: 'codex child', delayMs: 5000, stillRunning: () => true });
    vi.advanceTimersByTime(4999);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('does NOT escalate when the process already exited (exitCode set)', () => {
    const proc = makeProc();
    killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    proc.exitCode = 0; // child exited on SIGTERM
    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledTimes(1); // SIGTERM only
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('does NOT escalate when the process already exited via signal', () => {
    const proc = makeProc();
    killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    proc.signalCode = 'SIGTERM'; // terminated by the SIGTERM
    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('does NOT escalate when stillRunning() returns false (handle replaced/cleared)', () => {
    const proc = makeProc();
    let running = true;
    killWithEscalation(proc, { label: 'test job', stillRunning: () => running });
    running = false; // e.g. job.process was reassigned or cleared on close
    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('swallows a throw from the escalation callback (runs outside request lifecycle)', () => {
    const proc = makeProc();
    proc.kill = vi.fn((sig) => {
      if (sig === 'SIGKILL') throw new Error('boom');
      return true;
    });
    killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    // Advancing must not throw out of the fake-timer flush.
    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SIGKILL escalation failed'));
  });

  it('unref()s the escalation timer so it cannot hold the event loop open', () => {
    const proc = makeProc();
    const timer = killWithEscalation(proc, { label: 'test job', stillRunning: () => true });
    // Node timers expose unref(); assert we returned a timer handle.
    expect(timer).toBeDefined();
  });
});
