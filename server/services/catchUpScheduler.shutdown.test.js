import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extractDeclaration } from '../lib/mirrorParity.js';

const { getSettings, getSettingsWithStatus, runBackup, runScanPass } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSettingsWithStatus: vi.fn(),
  runBackup: vi.fn(),
  runScanPass: vi.fn(),
}));

vi.mock('./settings.js', () => ({
  getSettings, getSettingsWithStatus,
  settingsEvents: { on: vi.fn() },
  updateSettingsWith: vi.fn(async () => ({})),
}));
vi.mock('./backup.js', () => ({ runBackup, getState: vi.fn(async () => ({ lastRun: null })) }));
vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
  getTimezoneUpdatedAt: vi.fn(async () => null),
}));
vi.mock('./privacySubjects.js', () => ({
  listSubjects: vi.fn(async () => [{ id: 'example-subject', activeScopes: ['broker_scan'] }]),
}));
vi.mock('./privacyScan.js', () => ({ runScanPass }));
vi.mock('./privacyOptOut.js', () => ({ runOptOutPass: vi.fn(async () => ({})) }));

const BOOT_DELAY_MS = 5 * 60_000;
const bootstrapSource = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
const drainWindowMs = Number(bootstrapSource.match(/const HTTP_DRAIN_WINDOW_MS = (\d+);/)[1]);

// Run the real shutdown grace without booting the HTTP/DB service graph.
const boundedDrain = (scheduler) => runInNewContext(`
  ${extractDeclaration(bootstrapSource, 'withGrace')}
  withGrace('Scheduled events', drainWindowMs, ({ finish, finishWithError }) =>
    drain().then(() => finish(), err => finishWithError('Drain failed', err)));
`, { drain: scheduler.drain, drainWindowMs, setTimeout, console });

let scheduler;
let backupScheduler;
let privacyScheduler;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  getSettings.mockResolvedValue({
    backup: { enabled: true, destPath: '/example-backups', cronExpression: '0 0 * * *' },
    privacy: { recheck: { enabled: true, cronExpression: '0 4 * * 0', enabledAt: '2026-10-01T00:00:00.000Z' } },
  });
  getSettingsWithStatus.mockImplementation(async () => ({ corrupt: false, settings: await getSettings() }));
  runBackup.mockResolvedValue({ success: true });
  runScanPass.mockResolvedValue({});
  scheduler = await import('./eventScheduler.js');
  backupScheduler = await import('./backupScheduler.js');
  privacyScheduler = await import('./privacyRecheckScheduler.js');
});
afterEach(() => {
  backupScheduler?.stopBackupScheduler();
  privacyScheduler?.stopPrivacyRecheckScheduler();
  scheduler?.cancelAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const kind of ['backup', 'privacy']) {
  describe(`${kind} catch-up shutdown`, () => {
    const start = () => kind === 'backup'
      ? backupScheduler.startBackupScheduler()
      : privacyScheduler.startPrivacyRecheckScheduler({ catchUpMissedSlot: true });
    const stop = () => kind === 'backup'
      ? backupScheduler.stopBackupScheduler()
      : privacyScheduler.stopPrivacyRecheckScheduler();
    const work = () => kind === 'backup' ? runBackup : runScanPass;

    it('cannot start a pending catch-up after quiescence', async () => {
      await start();
      scheduler.quiesce();
      await scheduler.drain();
      await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
      expect(work()).not.toHaveBeenCalled();
      expect(scheduler.getStats()).toMatchObject({ activeEvents: 0, activeTimers: 0 });
    });

    it('cancels a pending catch-up when its scheduler stops', async () => {
      await start();
      stop();
      await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
      expect(work()).not.toHaveBeenCalled();
    });

    it('drains a started catch-up before teardown even after cancellation', async () => {
      let release;
      work().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await start();
      await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS - 1);
      expect(work()).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(work()).toHaveBeenCalledOnce();
      scheduler.quiesce();
      stop();
      const teardown = vi.fn();
      const closing = boundedDrain(scheduler).then(teardown);
      await vi.advanceTimersByTimeAsync(drainWindowMs - 1);
      expect(teardown).not.toHaveBeenCalled();
      release();
      await closing;
      expect(teardown).toHaveBeenCalledOnce();
    });

    it('keeps the existing shutdown deadline when the catch-up stalls', async () => {
      let release;
      work().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      await start();
      await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
      expect(work()).toHaveBeenCalledOnce();
      scheduler.quiesce();
      const teardown = vi.fn();
      const closing = boundedDrain(scheduler).then(teardown);
      await vi.advanceTimersByTimeAsync(drainWindowMs - 1);
      expect(teardown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(teardown).toHaveBeenCalledOnce();
      release();
      await scheduler.drain();
    });
  });
}
