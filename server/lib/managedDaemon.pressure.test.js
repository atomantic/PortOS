import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  evaluateMemoryPressurePolicy,
  formatReleaseTime,
  registerIdleDaemon,
  markDaemonUsed,
  daemonReleaseReason,
  clearDaemonReleaseReason,
  reapIdleDaemons,
  _resetIdleDaemonsForTests,
  DEFAULT_PRESSURE_THRESHOLD_BYTES,
  DEFAULT_PRESSURE_CALM_DOWN_MS,
  DEFAULT_SUSTAINED_PRESSURE_MS,
  createDaemonWatcher,
} from './managedDaemon.js';

const MINUTE = 60_000;
const GB = 1024 * 1024 * 1024;

describe('managedDaemon memory pressure policy', () => {
  beforeEach(() => {
    _resetIdleDaemonsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    _resetIdleDaemonsForTests();
    vi.restoreAllMocks();
  });

  describe('formatReleaseTime', () => {
    it('formats a timestamp into HH:MM', () => {
      const d = new Date(2026, 8, 4, 9, 14);
      expect(formatReleaseTime(d.getTime())).toBe('09:14');
    });
  });

  describe('evaluateMemoryPressurePolicy (pure function)', () => {
    const now = 1_000_000_000;
    const sustainedHistory = [
      { at: now - 40_000, free: 2 * GB },
      { at: now - 20_000, free: 2 * GB },
      { at: now, free: 2 * GB },
    ];

    it('returns shouldRelease: false when memoryStats is missing or invalid', () => {
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: null,
      });
      expect(result.shouldRelease).toBe(false);
      expect(result.reason).toBe('memory stats unavailable');
    });

    it('returns shouldRelease: false when memory is above threshold', () => {
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 50 * GB, free: 14 * GB },
        now,
      });
      expect(result.shouldRelease).toBe(false);
      expect(result.reason).toBe('host memory not under pressure');
    });

    it('stays under pressure when within dead-band hysteresis window', () => {
      // Threshold is 4GB, dead-band is 2GB, exit threshold is 6GB
      // When wasUnderPressure is true, 5GB free is still under pressure
      const resultInDeadBand = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 59 * GB, free: 5 * GB },
        history: [{ at: now - 40_000, free: 2 * GB }, { at: now, free: 5 * GB }],
        options: { wasUnderPressure: true, sustainedDurationMs: 0 },
        now,
      });
      expect(resultInDeadBand.shouldRelease).toBe(true);

      // Above threshold + dead-band (7GB >= 6GB), pressure is relieved
      const resultAboveDeadBand = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 57 * GB, free: 7 * GB },
        options: { wasUnderPressure: true },
        now,
      });
      expect(resultAboveDeadBand.shouldRelease).toBe(false);
      expect(resultAboveDeadBand.reason).toBe('host memory not under pressure');
    });

    it('treats dead-band samples as sustained pressure when wasUnderPressure', () => {
      // Threshold 4GB, dead-band 2GB, exit threshold 6GB. Free has held at 5GB —
      // inside the dead-band (below the exit threshold, above the base threshold)
      // — for well over the default 30s sustained window while wasUnderPressure.
      const deadBandHistory = [
        { at: now - 40_000, free: 5 * GB },
        { at: now - 20_000, free: 5 * GB },
        { at: now, free: 5 * GB },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 59 * GB, free: 5 * GB },
        history: deadBandHistory,
        options: { wasUnderPressure: true },
        now,
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.reason).toBe('host memory pressure');
    });

    it('returns shouldRelease: false when within the calm-down window', () => {
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
        lastReleasedAt: now - (DEFAULT_PRESSURE_CALM_DOWN_MS / 2),
      });
      expect(result.shouldRelease).toBe(false);
      expect(result.reason).toBe('in calm-down window');
      expect(result.remainingCalmDownMs).toBeGreaterThan(0);
    });

    it('returns shouldRelease: false when pressure is not sustained across the window', () => {
      // Free dipped below threshold just 5s ago, default sustained requirement is 30s
      const transientHistory = [
        { at: now - 60_000, free: 10 * GB },
        { at: now - 10_000, free: 10 * GB },
        { at: now - 5_000, free: 2 * GB },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 10_000 }],
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: transientHistory,
        now,
      });
      expect(result.shouldRelease).toBe(false);
      expect(result.reason).toBe('pressure not sustained');
    });

    it('releases the candidate when pressure is sustained and unpinned daemons exist', () => {
      const daemon = { name: 'mtplx', lastUsedAt: now - 10_000 };
      const result = evaluateMemoryPressurePolicy({
        daemons: [daemon],
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.target).toBe(daemon);
      expect(result.reason).toBe('host memory pressure');
    });

    it('releases the least recently used daemon when multiple candidates exist', () => {
      const daemons = [
        { name: 'slotstream', lastUsedAt: now - 5_000 },
        { name: 'mtplx', lastUsedAt: now - 30_000 }, // least recently used
        { name: 'other', lastUsedAt: now - 10_000 },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons,
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.target.name).toBe('mtplx');
    });

    it('never releases a daemon the user pinned or marked keepLoaded', () => {
      const daemons = [
        { name: 'mtplx', lastUsedAt: now - 60_000, pinned: true },
        { name: 'slotstream', lastUsedAt: now - 50_000, keepLoaded: true },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons,
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
      });
      expect(result.shouldRelease).toBe(false);
      expect(result.reason).toBe('no eligible daemons to release');
    });

    it('skips pinned daemon and releases the next least recently used unpinned daemon', () => {
      const daemons = [
        { name: 'mtplx', lastUsedAt: now - 60_000, pinned: true },
        { name: 'slotstream', lastUsedAt: now - 20_000, pinned: false },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons,
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.target.name).toBe('slotstream');
    });

    it('skips daemons that are not currently running', () => {
      const daemons = [
        { name: 'mtplx', lastUsedAt: now - 60_000, running: false },
        { name: 'slotstream', lastUsedAt: now - 20_000, running: true },
      ];
      const result = evaluateMemoryPressurePolicy({
        daemons,
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: sustainedHistory,
        now,
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.target.name).toBe('slotstream');
    });

    it('honors sustainedDurationMs: 0 for instant evaluation', () => {
      const result = evaluateMemoryPressurePolicy({
        daemons: [{ name: 'mtplx', lastUsedAt: now - 1000 }],
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [],
        now,
        options: { sustainedDurationMs: 0 },
      });
      expect(result.shouldRelease).toBe(true);
      expect(result.target.name).toBe('mtplx');
    });
  });

  describe('reapIdleDaemons pressure-aware integration', () => {
    it('stops the least recently used daemon early under sustained pressure', async () => {
      const stopMtplx = vi.fn().mockResolvedValue(undefined);
      const stopSlotstream = vi.fn().mockResolvedValue(undefined);

      // Window is 60 minutes, so neither would be stopped by normal idle timer
      registerIdleDaemon({ name: 'daemon-mtplx', getIdleMs: () => 60 * MINUTE, stop: stopMtplx });
      registerIdleDaemon({ name: 'daemon-slotstream', getIdleMs: () => 60 * MINUTE, stop: stopSlotstream });

      const now = Date.now();
      // mark slotstream used more recently
      markDaemonUsed('daemon-slotstream');

      const stopped = await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [
          { at: now - 40_000, free: 2 * GB },
          { at: now, free: 2 * GB },
        ],
        sustainedDurationMs: 30_000,
      });

      expect(stopped).toEqual(['daemon-mtplx']);
      expect(stopMtplx).toHaveBeenCalledTimes(1);
      expect(stopSlotstream).not.toHaveBeenCalled();

      // Reason recorded on the daemon entry
      const timeStr = formatReleaseTime(now);
      expect(daemonReleaseReason('daemon-mtplx')).toBe(`released at ${timeStr} — host memory pressure`);
    });

    it('releases at most one daemon per tick and re-reads before the next', async () => {
      const stopA = vi.fn().mockResolvedValue(undefined);
      const stopB = vi.fn().mockResolvedValue(undefined);

      registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 60 * MINUTE, stop: stopA });
      registerIdleDaemon({ name: 'daemon-b', getIdleMs: () => 60 * MINUTE, stop: stopB });

      const now = Date.now();
      const stopped = await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now - 35_000, free: 2 * GB }, { at: now, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });

      expect(stopped.length).toBe(1);
      expect(stopA.mock.calls.length + stopB.mock.calls.length).toBe(1);
    });

    it('never stops a pinned daemon under memory pressure', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      registerIdleDaemon({
        name: 'daemon-pinned',
        getIdleMs: () => 60 * MINUTE,
        isPinned: () => true,
        stop,
      });

      const now = Date.now();
      const stopped = await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now - 40_000, free: 2 * GB }, { at: now, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });

      expect(stopped).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
      expect(daemonReleaseReason('daemon-pinned')).toBeNull();
    });

    it('fail-safes to pinned when isPinned throws or rejects', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      registerIdleDaemon({
        name: 'daemon-flaky-pin',
        getIdleMs: () => 60 * MINUTE,
        isPinned: () => Promise.reject(new Error('transient read failure')),
        stop,
      });

      const now = Date.now();
      const stopped = await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now - 35_000, free: 2 * GB }, { at: now, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });

      expect(stopped).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
    });

    it('idle-timeout pass skips an already-stopped daemon instead of re-stopping it', async () => {
      let running = true;
      const stop = vi.fn().mockImplementation(() => {
        running = false;
        return Promise.resolve();
      });
      registerIdleDaemon({
        name: 'daemon-already-stopped',
        getIdleMs: () => 5 * MINUTE,
        isRunning: () => running,
        stop,
      });

      const now1 = Date.now();
      // Idle window (5m) hasn't elapsed since registration, so this falls through
      // to the pressure-aware pass, which stops it and records why.
      const stoppedByPressure = await reapIdleDaemons(now1, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now1 - 40_000, free: 2 * GB }, { at: now1, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });
      expect(stoppedByPressure).toEqual(['daemon-already-stopped']);
      expect(stop).toHaveBeenCalledTimes(1);
      const pressureReason = daemonReleaseReason('daemon-already-stopped');
      expect(pressureReason).toContain('host memory pressure');

      // The pressure stop reset lastUsedAt to now1 — advance past the idle
      // window without the daemon ever restarting.
      const now2 = now1 + 6 * MINUTE;
      const stoppedByIdle = await reapIdleDaemons(now2, { memoryStats: false });

      expect(stoppedByIdle).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(daemonReleaseReason('daemon-already-stopped')).toBe(pressureReason);
    });

    it('clears releaseReason when markDaemonUsed is called upon server restart', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      registerIdleDaemon({ name: 'daemon-a', getIdleMs: () => 60 * MINUTE, stop });

      const now = Date.now();
      await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now - 40_000, free: 2 * GB }, { at: now, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });

      expect(daemonReleaseReason('daemon-a')).toMatch(/host memory pressure/);

      // User or lazy start triggers markDaemonUsed
      markDaemonUsed('daemon-a');
      expect(daemonReleaseReason('daemon-a')).toBeNull();
    });

    it('reports releaseReason in watcher getStatusBase when stopped, and null when running', async () => {
      let pm2Status = { status: 'stopped', pid: null, args: [] };
      const watcher = createDaemonWatcher({
        appName: 'daemon-test',
        defaultPort: 8000,
        endpointFor: () => 'http://127.0.0.1:8000/v1',
        parseConfigFromArgs: () => ({}),
        probe: vi.fn().mockResolvedValue(false),
        isPortInUse: vi.fn().mockResolvedValue(false),
        sleep: vi.fn(),
        getConfig: () => null,
        setConfig: vi.fn(),
        getLastExitError: () => null,
        getAppStatus: vi.fn(async () => pm2Status),
        getSavedProcessNames: vi.fn(async () => []),
        execPm2: vi.fn(async () => ({ stdout: '', stderr: '' })),
        getPortReleaseTimeoutMs: () => 5000,
      });

      registerIdleDaemon({
        name: 'daemon-test',
        getIdleMs: () => 60 * MINUTE,
        stop: vi.fn(),
      });

      const now = Date.now();
      await reapIdleDaemons(now, {
        memoryStats: { total: 64 * GB, used: 62 * GB, free: 2 * GB },
        history: [{ at: now - 40_000, free: 2 * GB }, { at: now, free: 2 * GB }],
        sustainedDurationMs: 30_000,
      });

      const stoppedStatus = await watcher.getStatusBase({ installed: true });
      expect(stoppedStatus.releaseReason).toMatch(/host memory pressure/);

      // Now simulate server running online
      pm2Status = { status: 'online', pid: 1234, args: [] };
      const onlineStatus = await watcher.getStatusBase({ installed: true });
      expect(onlineStatus.releaseReason).toBeNull();
    });
  });
});
