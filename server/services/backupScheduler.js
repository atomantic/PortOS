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
import { getUserTimezone } from './userTimezone.js';
import { resolveBackupConfig } from '../lib/backupConfig.js';

const EVENT_ID = 'backup-daily';

// Only confirmed disabled or runnable configurations are cached.
// null means stopped or failed, so identical inputs can retry.
let reconciliationState = null;

/**
 * The registration-affecting slice of settings: `null` when backup scheduling
 * should be inactive (explicitly disabled, or no destination configured).
 */
function registrationInputs(settings) {
  const effective = resolveBackupConfig(settings?.backup);
  if (!effective.scheduled) return null;
  return { cron: effective.cronExpression };
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
  if (signature === reconciliationState?.signature) return reconciliationState.kind === 'scheduled';

  if (!inputs) {
    if (reconciliationState?.kind === 'scheduled') {
      cancel(EVENT_ID);
      console.log('💾 Backup scheduler: disabled or destPath cleared — cron cancelled');
    } else {
      console.log('💾 Backup scheduler: disabled or no destPath configured — nothing scheduled');
    }
    reconciliationState = { kind: 'disabled', signature };
    return false;
  }

  reconciliationState = attemptRegistration(inputs, timezone, signature);
  return reconciliationState?.kind === 'scheduled';
}

function attemptRegistration(inputs, timezone, signature) {
  // `schedule()` replaces an event with the same id, so a changed cron
  // expression cleanly re-registers. destPath, excludePaths and
  // disabledDefaultExcludes are re-read inside the handler so toggles saved in
  // the Settings UI take effect on the next scheduled run.
  // schedule() cancels the old event before validating its replacement.
  // A throw or missing next run leaves no confirmed state to cache.
  // This catch owns failures at boot / on the settings event bus, outside
  // the request lifecycle where errors would otherwise propagate to a caller.
  let event;
  try {
    event = schedule({
      id: EVENT_ID,
      type: 'cron',
      cron: inputs.cron,
      timezone,
      handler: async () => {
        const fresh = await getSettings();
        const effective = resolveBackupConfig(fresh.backup);
        if (!effective.enabled) {
          console.log('💾 Backup scheduler: disabled since registration — skipping run');
          return;
        }
        if (!effective.destPath) {
          console.log('💾 Backup scheduler: destPath cleared since registration — skipping run');
          return;
        }
        const excludePaths = fresh.backup?.excludePaths || [];
        const disabledDefaultExcludes = fresh.backup?.disabledDefaultExcludes || [];
        console.log('💾 Backup scheduler: running scheduled backup');
        await runBackup(effective.destPath, null, { excludePaths, disabledDefaultExcludes });
      },
      metadata: { source: 'backupScheduler' }
    });
  } catch (err) {
    console.error(`❌ Backup scheduler: cron "${inputs.cron}" rejected — no backup scheduled: ${err.message}`);
    return null;
  }

  // Not every bad expression throws: a five-field cron with an out-of-range
  // value (`99 1 * * *`) registers with no next run at all. Treat "registered
  // but never fires" as a failure too, so the state cache can't suppress a
  // retry once the user corrects it.
  if (!event?.nextRunAt) {
    cancel(EVENT_ID);
    console.error(`❌ Backup scheduler: cron "${inputs.cron}" has no next run time — no backup scheduled`);
    return null;
  }
  console.log(`💾 Backup scheduler: registered daily backup at cron "${inputs.cron}"`);
  return { kind: 'scheduled', signature };
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
  reconciliationState = null;
  console.log('💾 Backup scheduler: stopped');
}
