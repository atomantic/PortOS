import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scheduleMock = vi.fn();
vi.mock('./eventScheduler.js', () => ({ schedule: (...args) => scheduleMock(...args) }));

const { createSyncScheduler } = await import('./createSettingsGatedSyncScheduler.js');

let logs;
let logSpy;

beforeEach(() => {
  scheduleMock.mockClear();
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((line) => { logs.push(line); });
});

afterEach(() => {
  logSpy.mockRestore();
});

const build = (getConfig, runSync = vi.fn()) => ({
  start: createSyncScheduler({
    id: 'demo-sync',
    label: 'Demo',
    icon: '🧪',
    source: 'demoScheduler',
    getConfig,
    runSync,
  }),
  runSync,
});

describe('createSyncScheduler', () => {
  it('no-ops (and never schedules) when disabled in settings', async () => {
    const { start } = build(vi.fn(async () => ({ enabled: false, intervalMinutes: 25 })));

    await start();

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(logs).toContain('🧪 Demo sync scheduler: disabled in settings — skipping');
  });

  it('registers one interval job with the domain id, interval, and metadata source', async () => {
    const { start } = build(vi.fn(async () => ({ enabled: true, intervalMinutes: 25 })));

    await start();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [event] = scheduleMock.mock.calls[0];
    expect(event.id).toBe('demo-sync');
    expect(event.type).toBe('interval');
    // Minutes → ms, so a cadence change in settings can't silently become seconds.
    expect(event.intervalMs).toBe(25 * 60 * 1000);
    expect(event.metadata).toEqual({ source: 'demoScheduler' });
    expect(logs).toContain('🧪 Demo sync scheduler: registered every 25min');
  });

  it('runs the sync on tick while still enabled', async () => {
    const { start, runSync } = build(vi.fn(async () => ({ enabled: true, intervalMinutes: 25 })));

    await start();
    await scheduleMock.mock.calls[0][0].handler();

    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('re-reads enabled per tick so disabling in settings stops runs without a restart', async () => {
    const getConfig = vi.fn()
      .mockResolvedValueOnce({ enabled: true, intervalMinutes: 25 })
      .mockResolvedValue({ enabled: false, intervalMinutes: 25 });
    const { start, runSync } = build(getConfig);

    await start();
    await scheduleMock.mock.calls[0][0].handler();

    expect(runSync).not.toHaveBeenCalled();
    expect(logs).toContain('🧪 Demo sync scheduler: disabled since registration — skipping run');
  });

  it('keeps the registration interval locked even when settings change mid-flight', async () => {
    const getConfig = vi.fn()
      .mockResolvedValueOnce({ enabled: true, intervalMinutes: 25 })
      .mockResolvedValue({ enabled: true, intervalMinutes: 480 });
    const { start, runSync } = build(getConfig);

    await start();
    await scheduleMock.mock.calls[0][0].handler();

    expect(scheduleMock.mock.calls[0][0].intervalMs).toBe(25 * 60 * 1000);
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('throws when runSync reports a detected failure via { ok: false }, so the run is recorded failed (#7549)', async () => {
    const runSync = vi.fn(async () => ({ ok: false, error: 'Full Disk Access required' }));
    const { start } = build(vi.fn(async () => ({ enabled: true, intervalMinutes: 25 })), runSync);

    await start();

    await expect(scheduleMock.mock.calls[0][0].handler()).rejects.toThrow('Full Disk Access required');
  });

  it('does not throw when runSync succeeds with { ok: true }', async () => {
    const runSync = vi.fn(async () => ({ ok: true }));
    const { start } = build(vi.fn(async () => ({ enabled: true, intervalMinutes: 25 })), runSync);

    await start();

    await expect(scheduleMock.mock.calls[0][0].handler()).resolves.toBeUndefined();
  });
});
