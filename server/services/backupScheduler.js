/**
 * Backup Scheduler Service
 *
 * Registers a daily cron job for automated backups using eventScheduler.
 * Mirrors the brainScheduler.js pattern.
 */

import { schedule, cancel } from './eventScheduler.js';
import { getSettings } from './settings.js';
import { runBackup } from './backup.js';
import { getUserTimezone } from '../lib/timezone.js';

/**
 * Start the backup scheduler.
 * Reads backup settings and registers a daily cron job with eventScheduler.
 * No-ops if backup is disabled or destPath is not configured.
 */
export async function startBackupScheduler() {
  const settings = await getSettings();

  if (settings.backup?.enabled === false) {
    console.log('💾 Backup scheduler: disabled in settings — skipping');
    return;
  }

  if (!settings.backup?.destPath) {
    console.log('💾 Backup scheduler: no destPath configured — skipping');
    return;
  }

  const cronExpression = settings.backup?.cronExpression || '0 0 * * *';
  const timezone = await getUserTimezone();

  // The cron expression itself is locked in at registration time — changing it
  // requires a restart. But everything else (destPath, excludePaths,
  // disabledDefaultExcludes) is re-read inside the handler so toggles saved in
  // the Settings UI take effect on the next scheduled run without a restart.
  schedule({
    id: 'backup-daily',
    type: 'cron',
    cron: cronExpression,
    timezone,
    handler: async () => {
      const current = await getSettings();
      if (current.backup?.enabled === false) {
        console.log('💾 Backup scheduler: disabled since registration — skipping run');
        return;
      }
      const destPath = current.backup?.destPath;
      if (!destPath) {
        console.log('💾 Backup scheduler: destPath cleared since registration — skipping run');
        return;
      }
      const excludePaths = current.backup?.excludePaths || [];
      const disabledDefaultExcludes = current.backup?.disabledDefaultExcludes || [];
      console.log('💾 Backup scheduler: running scheduled backup');
      await runBackup(destPath, null, { excludePaths, disabledDefaultExcludes });
    },
    metadata: { source: 'backupScheduler' }
  });

  console.log(`💾 Backup scheduler: registered daily backup at cron "${cronExpression}" -> ${settings.backup.destPath}`);
}

/**
 * Stop the backup scheduler by cancelling the scheduled event.
 */
export function stopBackupScheduler() {
  cancel('backup-daily');
  console.log('💾 Backup scheduler: stopped');
}
