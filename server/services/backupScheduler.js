/**
 * Backup Scheduler Service
 *
 * Registers a daily cron job for automated backups using eventScheduler.
 * The registration is re-synced on every settings save (via settings.js's
 * `settingsEvents` bus), so enabling backups — or setting `destPath` — after
 * boot registers the cron immediately instead of waiting for a restart, and
 * disabling backups cancels it.
 */

import { schedule, cancel } from './eventScheduler.js';
import { getSettings, settingsEvents } from './settings.js';
import { runBackup } from './backup.js';
import { getUserTimezone } from '../lib/timezone.js';

const EVENT_ID = 'backup-daily';
const DEFAULT_CRON = '0 0 * * *';

// Registration state, so an unrelated settings save is a cheap no-op and a
// cancel only fires when a cron is actually registered.
let registered = false;
let lastSignature = null;

/**
 * The registration-affecting slice of settings: `null` when backup scheduling
 * should be inactive (explicitly disabled, or no destination configured).
 */
function registrationInputs(settings) {
  const backup = settings?.backup;
  if (backup?.enabled === false) return null;
  if (!backup?.destPath) return null;
  return { cron: backup.cronExpression || DEFAULT_CRON, destPath: backup.destPath };
}

/**
 * (Re)synchronize the backup cron to match the given settings snapshot.
 * Idempotent — safe to call at boot and after every settings save. Registering
 * a cron fires nothing until its expression elapses, so this never triggers a
 * backup by itself.
 * @param {object} [settings] - a settings snapshot; re-read when omitted
 * @returns {Promise<boolean>} whether a cron is registered after the sync
 */
export async function syncBackupSchedule(settings) {
  const current = settings || await getSettings().catch(() => null);
  const inputs = registrationInputs(current);
  const timezone = await getUserTimezone().catch(() => 'UTC');

  // Only `cron` + `timezone` + active/inactive are baked into the registration;
  // destPath and the exclude lists are re-read by the handler on every run.
  const signature = JSON.stringify({ active: Boolean(inputs), cron: inputs?.cron ?? null, tz: timezone });
  if (signature === lastSignature) return registered;
  lastSignature = signature;

  if (!inputs) {
    if (registered) {
      cancel(EVENT_ID);
      registered = false;
      console.log('💾 Backup scheduler: disabled or destPath cleared — cron cancelled');
    } else {
      console.log('💾 Backup scheduler: disabled or no destPath configured — nothing scheduled');
    }
    return false;
  }

  // `schedule()` replaces an event with the same id, so a changed cron
  // expression cleanly re-registers. destPath, excludePaths and
  // disabledDefaultExcludes are re-read inside the handler so toggles saved in
  // the Settings UI take effect on the next scheduled run.
  schedule({
    id: EVENT_ID,
    type: 'cron',
    cron: inputs.cron,
    timezone,
    handler: async () => {
      const fresh = await getSettings();
      if (fresh.backup?.enabled === false) {
        console.log('💾 Backup scheduler: disabled since registration — skipping run');
        return;
      }
      const destPath = fresh.backup?.destPath;
      if (!destPath) {
        console.log('💾 Backup scheduler: destPath cleared since registration — skipping run');
        return;
      }
      const excludePaths = fresh.backup?.excludePaths || [];
      const disabledDefaultExcludes = fresh.backup?.disabledDefaultExcludes || [];
      console.log('💾 Backup scheduler: running scheduled backup');
      await runBackup(destPath, null, { excludePaths, disabledDefaultExcludes });
    },
    metadata: { source: 'backupScheduler' }
  });
  registered = true;

  console.log(`💾 Backup scheduler: registered daily backup at cron "${inputs.cron}"`);
  return true;
}

// Re-sync on every settings save rather than from the settings route — keeps
// the HTTP handler decoupled from the backup graph (mirrors
// seriesAutopilotScheduler.js). The signature guard makes unrelated saves free.
settingsEvents.on('settings:updated', (cleaned) => {
  syncBackupSchedule(cleaned).catch(err =>
    console.error(`❌ Backup schedule re-sync failed: ${err.message}`));
});

/**
 * Boot entry point — registers the cron once at startup if backup is
 * configured. Later enable/disable/cron edits are picked up by the
 * `settings:updated` subscription above.
 */
export async function startBackupScheduler() {
  return syncBackupSchedule();
}

/**
 * Stop the backup scheduler by cancelling the scheduled event.
 */
export function stopBackupScheduler() {
  cancel(EVENT_ID);
  registered = false;
  lastSignature = null;
  console.log('💾 Backup scheduler: stopped');
}
