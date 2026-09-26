/**
 * Tests for backupScheduler — specifically that the cron handler re-reads
 * settings on each invocation, so toggle changes in the Backup UI take
 * effect on the next scheduled run without a server restart.
 *
 * Prior bug: destPath/excludePaths/disabledDefaultExcludes were closed over
 * at registration time, so saving a toggle updated settings.json but the
 * already-scheduled handler kept using the old values until restart.
 *
 * Also covers the registration re-sync (#3910): enabling backups or setting
 * destPath after boot must register the cron without a restart.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./eventScheduler.js', () => ({
  // The real schedule() returns the registered event; the scheduler treats a
  // null nextRunAt as a failed registration, so the default mock returns a
  // firing one.
  schedule: vi.fn(() => ({ id: 'backup-daily', nextRunAt: Date.now() + 60_000 })),
  cancel: vi.fn(),
  // Defaults to "no missed slot" so every pre-existing test above stays
  // unaffected by the #8456 catch-up check that now runs on every boot.
  parseCronToPrevRun: vi.fn(() => null)
}));

// The scheduler subscribes to `settings:updated` at module load, so the mock
// needs a working emitter the re-sync tests below can fire. `vi.hoisted` runs
// above the import block, so it is built by hand rather than importing
// node:events up there.
const { settingsEvents } = vi.hoisted(() => {
  const listeners = new Map();
  return {
    settingsEvents: {
      on: (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]); },
      emit: (event, payload) => { for (const fn of listeners.get(event) || []) fn(payload); }
    }
  };
});
vi.mock('./settings.js', () => {
  // getSettingsWithStatus defaults to wrapping getSettings as a clean read
  // (`corrupt: false`), matching production for every test that only sets up
  // `getSettings.mockResolvedValue(...)`. Corrupt-read tests override
  // getSettingsWithStatus directly.
  const getSettings = vi.fn();
  const getSettingsWithStatus = vi.fn(async () => ({ corrupt: false, settings: await getSettings() }));
  return { getSettings, getSettingsWithStatus, settingsEvents };
});

vi.mock('./backup.js', () => ({
  runBackup: vi.fn().mockResolvedValue({ success: true }),
  // "never run" — matches backup.js's own DEFAULT_STATE, so a test that
  // doesn't override this sees the same "no prior run" starting point.
  getState: vi.fn().mockResolvedValue({ lastRun: null })
}));

vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getTimezoneUpdatedAt: vi.fn().mockResolvedValue(null)
}));

import { schedule, cancel, parseCronToPrevRun } from './eventScheduler.js';
import { getSettings, getSettingsWithStatus } from './settings.js';
import { runBackup, getState } from './backup.js';
import { getTimezoneUpdatedAt } from './userTimezone.js';
import { startBackupScheduler, stopBackupScheduler, syncBackupSchedule } from './backupScheduler.js';

describe('startBackupScheduler', () => {
  beforeEach(() => {
    // Registration state is module-level and persists across tests in this
    // file — reset it (and the mock call log it dirties) before each case.
    stopBackupScheduler();
    vi.clearAllMocks();
  });

  it('skips registration when backup is disabled', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: false, destPath: '/dest' } });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('skips registration when destPath is missing', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true } });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('registers a daily cron with the configured expression', async () => {
    getSettings.mockResolvedValue({
      backup: { enabled: true, destPath: '/dest', cronExpression: '0 3 * * *' }
    });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: 'backup-daily',
      type: 'cron',
      cron: '0 3 * * *',
      timezone: 'UTC'
    });
  });

  it('handler re-reads settings on each invocation (no startup-snapshot staleness)', async () => {
    // First call: registration reads stale settings.
    getSettings.mockResolvedValueOnce({
      backup: { enabled: true, destPath: '/dest-original', excludePaths: ['stale/'], disabledDefaultExcludes: [] }
    });
    await startBackupScheduler();

    // Second call: scheduled handler fires later, settings have changed.
    getSettings.mockResolvedValueOnce({
      backup: {
        enabled: true,
        destPath: '/dest-fresh',
        excludePaths: ['fresh/'],
        disabledDefaultExcludes: ['/loras/*.safetensors']
      }
    });

    // Invoke the registered handler.
    const handler = schedule.mock.calls[0][0].handler;
    await handler();

    expect(runBackup).toHaveBeenCalledWith(
      '/dest-fresh',
      null,
      { excludePaths: ['fresh/'], disabledDefaultExcludes: ['/loras/*.safetensors'], retentionCount: null }
    );
  });

  it('handler skips the run if backup was disabled since registration', async () => {
    getSettings.mockResolvedValueOnce({
      backup: { enabled: true, destPath: '/dest', excludePaths: [], disabledDefaultExcludes: [] }
    });
    await startBackupScheduler();

    // User toggled "Enabled" off in the UI before the cron fired.
    getSettings.mockResolvedValueOnce({
      backup: { enabled: false, destPath: '/dest' }
    });

    const handler = schedule.mock.calls[0][0].handler;
    await handler();

    expect(runBackup).not.toHaveBeenCalled();
  });

  it('handler skips the run if destPath has been cleared since registration', async () => {
    getSettings.mockResolvedValueOnce({
      backup: { enabled: true, destPath: '/dest', excludePaths: [], disabledDefaultExcludes: [] }
    });
    await startBackupScheduler();

    // User cleared destPath in the UI before the cron fired.
    getSettings.mockResolvedValueOnce({ backup: { enabled: true } });

    const handler = schedule.mock.calls[0][0].handler;
    await handler();

    expect(runBackup).not.toHaveBeenCalled();
  });
});

/**
 * Regression (#3910): before this, registration happened ONCE at boot. A user
 * who enabled backups (or set destPath) afterwards got no scheduled run at all
 * until the server process was restarted.
 */
describe('settings:updated re-sync', () => {
  const emitSettings = async (settings) => {
    settingsEvents.emit('settings:updated', settings);
    // The listener is async (it awaits getUserTimezone) — let it settle.
    await new Promise(resolve => setImmediate(resolve));
  };

  beforeEach(() => {
    stopBackupScheduler();
    vi.clearAllMocks();
  });

  it('registers the cron when backup is enabled after boot', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: false } });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();

    await emitSettings({ backup: { enabled: true, destPath: '/dest', cronExpression: '0 4 * * *' } });

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ id: 'backup-daily', cron: '0 4 * * *' });
  });

  it('registers the cron when destPath is configured after boot', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true } });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();

    await emitSettings({ backup: { enabled: true, destPath: '/dest' } });

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ cron: '0 0 * * *' });
  });

  it('re-registers when the cron expression changes', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest', cronExpression: '0 1 * * *' } });
    await startBackupScheduler();

    await emitSettings({ backup: { enabled: true, destPath: '/dest', cronExpression: '0 5 * * *' } });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[1][0]).toMatchObject({ id: 'backup-daily', cron: '0 5 * * *' });
  });

  it('cancels the cron when backup is disabled after boot', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest' } });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);

    await emitSettings({ backup: { enabled: false, destPath: '/dest' } });

    expect(cancel).toHaveBeenCalledWith('backup-daily');
  });

  it('retries after a rejected cron instead of short-circuiting on it', async () => {
    // eventScheduler.schedule() cancels the existing event BEFORE validating the
    // replacement, so a bad cron leaves nothing registered — the next save must
    // re-attempt even when it submits the identical (now-fixed) settings.
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest', cronExpression: 'nonsense' } });
    schedule.mockImplementationOnce(() => { throw new Error('Cron type requires cron expression'); });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);

    // Same inputs again: the failed attempt must not be remembered as applied.
    await emitSettings({ backup: { enabled: true, destPath: '/dest', cronExpression: 'nonsense' } });
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('retries when the cron registered but has no next run time', async () => {
    // An out-of-range five-field expression (`99 1 * * *`) registers without
    // throwing but never fires — that must not be cached as applied.
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest', cronExpression: '99 1 * * *' } });
    schedule.mockImplementationOnce(() => ({ id: 'backup-daily', nextRunAt: null }));
    await startBackupScheduler();
    expect(cancel).toHaveBeenCalledWith('backup-daily');

    await emitSettings({ backup: { enabled: true, destPath: '/dest', cronExpression: '99 1 * * *' } });
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for a save that does not touch backup registration', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest' } });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);

    // destPath and excludes are re-read by the handler, so a change to them
    // must not churn the registration.
    await emitSettings({ backup: { enabled: true, destPath: '/other', excludePaths: ['x/'] } });

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('backup schedule defaults (#6632)', () => {
  beforeEach(() => {
    stopBackupScheduler();
    vi.clearAllMocks();
  });

  // A destination-only config is the shape a user who never touched the toggle
  // has on disk. It must schedule — that is the behavior the settings GET now
  // reports, and the compatibility contract this change preserves.
  it('registers midnight for a destination-only configuration', async () => {
    getSettings.mockResolvedValue({ backup: { destPath: '/example-backups' } });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ cron: '0 0 * * *' });
  });

  // The regression itself: the Settings screen reads the resolved values and
  // saves them back verbatim when the user edits something unrelated. Feeding
  // that saved slice into registration must not change what is scheduled.
  it('keeps the same registration when the resolved values are saved back', async () => {
    getSettings.mockResolvedValue({ backup: { destPath: '/example-backups' } });
    await startBackupScheduler();
    const first = schedule.mock.calls[0][0].cron;

    // What the settings GET now hands the screen, plus the unrelated edit.
    settingsEvents.emit('settings:updated', {
      backup: { destPath: '/example-backups', enabled: true, cronExpression: '0 0 * * *', excludePaths: ['/scratch'] }
    });
    // The re-sync runs on the event bus, so let its promise settle before asserting.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first).toBe('0 0 * * *');
    // Identical registration inputs → the signature guard makes this a no-op.
    // A cancel here is the bug: the screen's save disabling a live schedule.
    expect(cancel).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  // The handler re-reads settings, so it needs the same interpretation as
  // registration — otherwise a sparse config registers but never runs.
  it('runs the backup when the re-read settings omit enabled', async () => {
    getSettings.mockResolvedValue({ backup: { destPath: '/example-backups' } });
    await startBackupScheduler();
    await schedule.mock.calls[0][0].handler();
    expect(runBackup).toHaveBeenCalledWith('/example-backups', null, {
      excludePaths: [], disabledDefaultExcludes: [], retentionCount: null
    });
  });
});

describe('confirmed backup schedule lifecycle', () => {
  beforeEach(() => {
    stopBackupScheduler();
    vi.clearAllMocks();
  });

  it('applies disable once and retries the same schedule after stopping', async () => {
    const settings = { backup: { enabled: true, destPath: '/dest' } };
    getSettings.mockResolvedValue(settings);
    expect(await startBackupScheduler()).toBe(true);
    expect(await syncBackupSchedule({ backup: { enabled: false } })).toBe(false);
    expect(await syncBackupSchedule({ backup: { enabled: false } })).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await startBackupScheduler()).toBe(true);
    stopBackupScheduler();
    expect(await startBackupScheduler()).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it.each(['throw', 'no next run'])('forgets a successful signature after replacement fails with %s', async (failure) => {
    const original = { backup: { enabled: true, destPath: '/dest', cronExpression: '0 1 * * *' } };
    expect(await syncBackupSchedule(original)).toBe(true);
    schedule.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('Rejected replacement');
      return { id: 'backup-daily', nextRunAt: null };
    });
    expect(await syncBackupSchedule({
      backup: { ...original.backup, cronExpression: '0 2 * * *' }
    })).toBe(false);
    expect(await syncBackupSchedule(original)).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(3);
  });
});

/**
 * #8428: a boot-time read of settings.json that is unreadable/malformed must
 * not be treated as "backup disabled". Before this, `getSettings()` collapsed
 * that failure to `{}`, so `registrationInputs({})` was `null` and the
 * scheduler cached a confirmed `disabled` state — permanently, since nothing
 * re-triggers a sync until the next successful settings save.
 */
describe('corrupt settings read at boot (#8428)', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    stopBackupScheduler();
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('logs an error and registers nothing new on a corrupt boot read, without logging "disabled"', async () => {
    getSettingsWithStatus.mockResolvedValueOnce({ corrupt: true, settings: {} });
    await startBackupScheduler();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('❌ Backup scheduler: settings unreadable'));
  });

  it('does not cancel an already-registered cron when a later read is corrupt', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest' } });
    await startBackupScheduler();
    expect(schedule).toHaveBeenCalledTimes(1);

    getSettingsWithStatus.mockResolvedValueOnce({ corrupt: true, settings: {} });
    expect(await syncBackupSchedule()).toBe(true);

    expect(cancel).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('registers once a later clean read succeeds, via settings:invalidated rather than a save', async () => {
    getSettingsWithStatus.mockResolvedValueOnce({ corrupt: true, settings: {} });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();

    getSettings.mockResolvedValue({ backup: { enabled: true, destPath: '/dest', cronExpression: '0 3 * * *' } });
    settingsEvents.emit('settings:invalidated');
    await new Promise(resolve => setImmediate(resolve));

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ cron: '0 3 * * *' });
  });
});

/**
 * #8456: the daily backup cron fires nothing until its expression elapses, so
 * an install where the daemon was down (or crash-looping) across the
 * scheduled time gets zero backups that day, and — if the machine is
 * consistently off at that time — ever. Boot now checks whether the most
 * recent slot elapsed without a backup and, if so, runs a one-time catch-up
 * after a fixed delay so it never piles onto boot-time migrations/warm-up.
 */
describe('missed-slot catch-up at boot (#8456)', () => {
  const SETTINGS = { backup: { enabled: true, destPath: '/dest', cronExpression: '0 0 * * *' } };
  const MISSED_SLOT = new Date('2026-01-02T00:00:00.000Z');

  beforeEach(() => {
    stopBackupScheduler();
    vi.clearAllMocks();
    parseCronToPrevRun.mockReturnValue(null);
    getState.mockResolvedValue({ lastRun: null });
    getTimezoneUpdatedAt.mockResolvedValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a catch-up backup after the boot delay when the last run predates the missed slot', async () => {
    getSettings.mockResolvedValue(SETTINGS);
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' }); // yesterday's slot only

    await startBackupScheduler();
    expect(runBackup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).toHaveBeenCalledWith('/dest', null, {
      excludePaths: [], disabledDefaultExcludes: [], retentionCount: null
    });
  });

  it('does not catch up when the last run is at or after the most recent slot', async () => {
    getSettings.mockResolvedValue(SETTINGS);
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: MISSED_SLOT.toISOString() });

    await startBackupScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it('suppresses catch-up when the backup config changed after the missed slot', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, backupConfigUpdatedAt: MISSED_SLOT.getTime() + 60_000 });
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });

    await startBackupScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it('suppresses catch-up when the timezone changed after the missed slot', async () => {
    getSettings.mockResolvedValue(SETTINGS);
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });
    getTimezoneUpdatedAt.mockResolvedValue(MISSED_SLOT.getTime() + 60_000);

    await startBackupScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it('never catches up when backup is disabled', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: false, destPath: '/dest' } });
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });

    await startBackupScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(parseCronToPrevRun).not.toHaveBeenCalled(); // never scheduled, so nothing to catch up
  });

  it('never catches up when destPath is missing', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: true } });
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });

    await startBackupScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
    expect(parseCronToPrevRun).not.toHaveBeenCalled();
  });

  it('attempts at most one catch-up per boot, even if a settings save re-syncs immediately after', async () => {
    getSettings.mockResolvedValue(SETTINGS);
    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });

    await startBackupScheduler();
    expect(parseCronToPrevRun).toHaveBeenCalledTimes(1);

    // A same-signature re-sync (e.g. an unrelated settings save) must not
    // re-evaluate the missed slot a second time this boot.
    await syncBackupSchedule(SETTINGS, { catchUpMissedSlot: true });
    expect(parseCronToPrevRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it('a settings:updated re-sync does not itself trigger a catch-up', async () => {
    getSettings.mockResolvedValue({ backup: { enabled: false } });
    await startBackupScheduler();
    expect(schedule).not.toHaveBeenCalled();

    parseCronToPrevRun.mockReturnValue(MISSED_SLOT);
    getState.mockResolvedValue({ lastRun: '2026-01-01T00:00:00.000Z' });
    settingsEvents.emit('settings:updated', SETTINGS);
    // The listener is async (it awaits getUserTimezone) — advance by 0 to let
    // it settle without relying on `setImmediate`, which fake timers also fake.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runBackup).not.toHaveBeenCalled();
  });
});
