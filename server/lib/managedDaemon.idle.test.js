import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  idleWindowMs,
  registerIdleDaemon,
  markDaemonUsed,
  daemonLastUsedAt,
  reapIdleDaemons,
  startIdleReaper,
  stopIdleReaper,
  _resetIdleDaemonsForTests,
} from './managedDaemon.js';

const MINUTE = 60_000;

describe('managedDaemon idle reaper', () => {
  beforeEach(() => {
    _resetIdleDaemonsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    _resetIdleDaemonsForTests();
    vi.restoreAllMocks();
  });

  describe('idleWindowMs', () => {
    it('converts minutes to milliseconds', () => {
      expect(idleWindowMs(30)).toBe(30 * MINUTE);
    });

    // 0 is a real choice ("never stop"), not the absence of one — collapsing it
    // into null would make a stored 0 indistinguishable from an unset field.
    it('keeps 0 as 0 rather than folding it into null', () => {
      expect(idleWindowMs(0)).toBe(0);
      expect(idleWindowMs(null)).toBeNull();
      expect(idleWindowMs('not a number')).toBeNull();
      expect(idleWindowMs(-5)).toBeNull();
    });
  });

  it('stops a daemon whose idle window has elapsed', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    // 31 minutes after the last use.
    const stopped = await reapIdleDaemons(Date.now() + 31 * MINUTE);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopped).toEqual(['daemon-a']);
  });

  it('leaves a daemon used inside the window alone', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    const stopped = await reapIdleDaemons(Date.now() + 29 * MINUTE);

    expect(stop).not.toHaveBeenCalled();
    expect(stopped).toEqual([]);
  });

  it('never stops a daemon whose window is 0', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 0, stop });

    // A year of idleness is still not enough when the user said "never".
    const stopped = await reapIdleDaemons(Date.now() + 525_600 * MINUTE);

    expect(stop).not.toHaveBeenCalled();
    expect(stopped).toEqual([]);
  });

  it('never stops a daemon with no configured window', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => null, stop });

    expect(await reapIdleDaemons(Date.now() + 10_000 * MINUTE)).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  // The acceptance criterion that makes the feature safe to leave on: a server
  // the user started thirty seconds ago must not be reaped because its
  // registration carried no use history.
  it('gives a freshly registered daemon a full window before it is eligible', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    expect(await reapIdleDaemons(now + 29 * MINUTE)).toEqual([]);
    expect(await reapIdleDaemons(now + 31 * MINUTE)).toEqual(['daemon-a']);
  });

  it('refreshes the clock on use', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    const before = daemonLastUsedAt('daemon-a');
    await new Promise((r) => setTimeout(r, 2));
    markDaemonUsed('daemon-a');

    expect(daemonLastUsedAt('daemon-a')).toBeGreaterThan(before);
  });

  it('ignores a mark for an unregistered daemon rather than throwing', () => {
    expect(() => markDaemonUsed('never-registered')).not.toThrow();
    expect(daemonLastUsedAt('never-registered')).toBeNull();
  });

  // A re-registration (a manager module reloaded under test, or re-imported)
  // must not reset a clock that is already ticking.
  it('preserves lastUsedAt across a re-registration', async () => {
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop: vi.fn() });
    const first = daemonLastUsedAt('daemon-a');

    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    expect(daemonLastUsedAt('daemon-a')).toBe(first);
  });

  // A stop that fails leaves the daemon UP. Resetting its clock anyway would
  // retry every single beat forever; leaving the clock stale lets the next
  // sweep try again without pretending the stop worked.
  it('reports a failed stop and does not count it as stopped', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('pm2 unreachable'));
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop });

    const stopped = await reapIdleDaemons(Date.now() + 31 * MINUTE);

    expect(stopped).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('pm2 unreachable'));
  });

  it('keeps sweeping the other daemons after one throws', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const healthy = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 30 * MINUTE, stop: failing });
    registerIdleDaemon({ name: 'daemon-b', getIdleMs: () => 30 * MINUTE, stop: healthy });

    expect(await reapIdleDaemons(Date.now() + 31 * MINUTE)).toEqual(['daemon-b']);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  // The window is resolved per sweep so a settings change lands on the next
  // beat rather than at the next server restart.
  it('re-reads the window on every sweep', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    let windowMs = 0;
    registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => windowMs, stop });

    const now = Date.now();
    expect(await reapIdleDaemons(now + 60 * MINUTE)).toEqual([]);

    windowMs = 30 * MINUTE;
    expect(await reapIdleDaemons(now + 60 * MINUTE)).toEqual(['daemon-a']);
  });

  it('treats a window lookup that throws as "never stop"', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    registerIdleDaemon({
      name: 'daemon-a',
      getIdleMs: () => Promise.reject(new Error('settings unreadable')),
      stop,
    });

    expect(await reapIdleDaemons(Date.now() + 10_000 * MINUTE)).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  describe('startIdleReaper', () => {
    afterEach(() => stopIdleReaper());

    it('arms exactly one timer no matter how many times it is called', () => {
      const spy = vi.spyOn(global, 'setInterval');
      startIdleReaper({ intervalMs: 60_000 });
      startIdleReaper({ intervalMs: 60_000 });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('stops sweeping once disarmed', async () => {
      // Fake time makes "five intervals passed" exact rather than a real sleep a
      // loaded worker can outrun (#12047).
      vi.useFakeTimers();
      try {
        const stop = vi.fn().mockResolvedValue(undefined);
        // Window 0 so a stray sweep can't stop it — this asserts the timer, not the policy.
        registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 0, stop });
        startIdleReaper({ intervalMs: 5 });
        stopIdleReaper();
        await vi.advanceTimersByTimeAsync(25);
        expect(vi.getTimerCount()).toBe(0);
        expect(stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
