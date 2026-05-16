/**
 * Tests for backupScheduler — specifically that the cron handler re-reads
 * settings on each invocation, so toggle changes in the Backup UI take
 * effect on the next scheduled run without a server restart.
 *
 * Prior bug: destPath/excludePaths/disabledDefaultExcludes were closed over
 * at registration time, so saving a toggle updated settings.json but the
 * already-scheduled handler kept using the old values until restart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn()
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn()
}));

vi.mock('./backup.js', () => ({
  runBackup: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC')
}));

import { schedule } from './eventScheduler.js';
import { getSettings } from './settings.js';
import { runBackup } from './backup.js';
import { startBackupScheduler } from './backupScheduler.js';

describe('startBackupScheduler', () => {
  beforeEach(() => {
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
      { excludePaths: ['fresh/'], disabledDefaultExcludes: ['/loras/*.safetensors'] }
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
