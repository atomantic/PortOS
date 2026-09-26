/**
 * Backup Scheduler Service
 *
 * Registers a daily cron job for automated backups using eventScheduler.
 * The registration is re-synced on every settings save (via settings.js's
 * `settingsEvents` bus), so enabling backups — or setting `destPath` — after
 * boot registers the cron immediately instead of waiting for a restart, and
 * disabling backups cancels it.
 */

import { schedule, cancel, parseCronToPrevRun } from './eventScheduler.js';
import { getSettings, getSettingsWithStatus, settingsEvents } from './settings.js';
import { runBackup, getState } from './backup.js';
import { getUserTimezone, getTimezoneUpdatedAt } from './userTimezone.js';
import { resolveBackupConfig } from '../lib/backupConfig.js';

const EVENT_ID = 'backup-daily';

// How long to wait before retrying a boot-time read that came back corrupt
// (issue #8428) — long enough to skip past a transient EIO/iCloud-dataless
// blip without spamming retries, short enough that the schedule self-heals
// well inside a normal session.
const CORRUPT_SETTINGS_RETRY_MS = 60_000;

// Boot delay before a detected missed-slot catch-up actually runs (#8456) —
// long enough that it never piles onto boot-time migrations and store
// warm-up, short enough that it still runs well inside a normal session.
const CATCHUP_BOOT_DELAY_MS = 5 * 60_000;

// Only confirmed disabled or runnable configurations are cached.
// null means stopped or failed, so identical inputs can retry.
let reconciliationState = null;

// Guards against stacking multiple boot-retry timers while settings.json
// stays unreadable across several syncBackupSchedule() calls.
let corruptRetryTimer = null;

// At most one missed-slot catch-up attempt per process boot (#8456) — set the
// moment a catch-up is EVALUATED (whether or not one is actually scheduled),
// so a settings save right after boot can't re-arm a second attempt.
let catchUpEvaluated = false;

// The pending catch-up timer, so stopBackupScheduler() (used between tests,
// and by anything that tears the scheduler down) can cancel it.
let catchUpTimer = null;

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
 * Re-read settings and run a backup if it is still wanted — the cron handler
 * body, shared with the missed-slot catch-up (#8456) so both paths respect a
 * disable/destPath-clear that happened after registration/detection.
 * @param {string} logReason - what triggered this run, for the log line
 */
async function runScheduledBackup(logReason) {
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
  console.log(`💾 Backup scheduler: running ${logReason} backup`);
  await runBackup(effective.destPath, null, { excludePaths, disabledDefaultExcludes, retentionCount: effective.retentionCount });
}

/**
 * If the most recent cron slot elapsed without a backup — the server was down
 * or crash-looping across it (#8456) — schedule a one-time catch-up run after
 * a fixed boot delay. At most one evaluation per process boot: `catchUpEvaluated`
 * is set here regardless of outcome, so a settings save immediately after boot
 * can't re-arm a second attempt for a slot this same boot already judged.
 *
 * Skipped when the registration-affecting config (cron/enabled/destPath) OR
 * the global timezone changed AFTER the missed slot — `backupConfigUpdatedAt`
 * / `timezoneUpdatedAt` are stamped by settings.js's `save()` only when those
 * fields actually change, so an install that never touched them keeps the
 * plain catch-up (sentinel `0` never gates), mirroring
 * `dailyReminderScheduler.js`'s two `updatedAt` floors.
 */
async function maybeCatchUpMissedSlot(inputs, timezone, settings) {
  if (catchUpEvaluated) return;
  catchUpEvaluated = true;
  try {
    const prevRun = parseCronToPrevRun(inputs.cron, new Date(), timezone);
    if (!prevRun) return;
    const prevRunMs = prevRun.getTime();

    const state = await getState().catch(() => null);
    const lastRunMs = state?.lastRun ? new Date(state.lastRun).getTime() : NaN;
    if (Number.isFinite(lastRunMs) && lastRunMs >= prevRunMs) return; // not missed

    const configUpdatedAt = Number(settings?.backupConfigUpdatedAt) || 0;
    const timezoneUpdatedAt = (await getTimezoneUpdatedAt().catch(() => null)) || 0;
    const cutoff = Math.max(configUpdatedAt, timezoneUpdatedAt);
    if (cutoff && prevRunMs < cutoff) {
      console.log(`💾 Backup scheduler: missed slot (${prevRun.toISOString()}) predates last config/timezone change — skipping catch-up`);
      return;
    }

    console.log(`💾 Backup scheduler: missed slot ${prevRun.toISOString()} — catching up in ${Math.round(CATCHUP_BOOT_DELAY_MS / 60_000)}m`);
    catchUpTimer = setTimeout(() => {
      catchUpTimer = null;
      runScheduledBackup('missed-slot catch-up').catch(err =>
        console.error(`❌ Backup scheduler: catch-up run failed: ${err.message}`));
    }, CATCHUP_BOOT_DELAY_MS);
    catchUpTimer.unref?.();
  } catch (err) {
    console.error(`❌ Backup scheduler: missed-slot check failed: ${err.message}`);
  }
}

/**
 * (Re)synchronize the backup cron to match the given settings snapshot.
 * Idempotent — safe to call at boot and after every settings save. Registering
 * a cron fires nothing until its expression elapses, so this never triggers a
 * backup by itself.
 * @param {object} [settings] - a settings snapshot; re-read when omitted
 * @param {object} [options]
 * @param {boolean} [options.catchUpMissedSlot] - Check for and schedule a
 *   catch-up for a slot that already elapsed (server-restart recovery). Only
 *   the boot-time call (`startBackupScheduler`) sets this; a reschedule from a
 *   settings/timezone save must not replay a slot the user did not miss.
 * @returns {Promise<boolean>} whether a cron is registered after the sync
 */
export async function syncBackupSchedule(settings, { catchUpMissedSlot = false } = {}) {
  if (!settings) {
    // No explicit snapshot: this is the boot path (or a corrupt-read retry),
    // so read through the strict status so an unreadable/malformed
    // settings.json is distinguishable from "backup genuinely disabled"
    // (issue #8428). `settings:updated` always hands syncBackupSchedule a
    // clean parsed snapshot, so the explicit-argument path is unaffected.
    const { corrupt, settings: read } = await getSettingsWithStatus().catch(() => ({ corrupt: true, settings: {} }));
    if (corrupt) {
      console.error('❌ Backup scheduler: settings unreadable — keeping current registration, will retry on next settings change');
      const wasScheduled = reconciliationState?.kind === 'scheduled';
      // Don't cache a signature/state for a failed read — the next sync
      // (settings:invalidated, or the boot retry below) must re-evaluate
      // rather than treating this as a confirmed disabled state.
      reconciliationState = null;
      scheduleCorruptRetry(catchUpMissedSlot);
      return wasScheduled;
    }
    return syncBackupSchedule(read, { catchUpMissedSlot });
  }
  const current = settings;
  const inputs = registrationInputs(current);
  const timezone = await getUserTimezone().catch(() => 'UTC');

  // Only `cron` + `timezone` + active/inactive are baked into the registration;
  // destPath and the exclude lists are re-read by the handler on every run.
  const signature = JSON.stringify({ active: Boolean(inputs), cron: inputs?.cron ?? null, tz: timezone });
  if (signature === reconciliationState?.signature) {
    if (inputs && catchUpMissedSlot) await maybeCatchUpMissedSlot(inputs, timezone, current);
    return reconciliationState.kind === 'scheduled';
  }

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
  if (reconciliationState?.kind === 'scheduled' && catchUpMissedSlot) {
    await maybeCatchUpMissedSlot(inputs, timezone, current);
  }
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
      handler: () => runScheduledBackup('scheduled'),
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

/**
 * Arm a single one-shot retry after a corrupt boot/re-sync read (#8428), so a
 * transient failure self-heals without waiting for a user-driven settings
 * save. Runs outside the request lifecycle — the process-boundary try/catch
 * convention applies, not the route error-bubbling one.
 */
function scheduleCorruptRetry(catchUpMissedSlot = false) {
  if (corruptRetryTimer) return;
  corruptRetryTimer = setTimeout(() => {
    corruptRetryTimer = null;
    syncBackupSchedule(undefined, { catchUpMissedSlot }).catch(err =>
      console.error(`❌ Backup scheduler: corrupt-settings retry failed: ${err.message}`));
  }, CORRUPT_SETTINGS_RETRY_MS);
  corruptRetryTimer.unref?.();
}

// Re-sync on every settings save rather than from the settings route — keeps
// the HTTP handler decoupled from the backup graph (mirrors
// seriesAutopilotScheduler.js). The signature guard makes unrelated saves free.
settingsEvents.on('settings:updated', (cleaned) => {
  syncBackupSchedule(cleaned).catch(err =>
    console.error(`❌ Backup schedule re-sync failed: ${err.message}`));
});

// A corrupt boot read invalidates the settings read cache (settings.js's
// reloadSettings()); re-sync as soon as a later read clears, without waiting
// for a settings:updated save (#8428).
settingsEvents.on('settings:invalidated', () => {
  syncBackupSchedule().catch(err =>
    console.error(`❌ Backup schedule invalidation re-sync failed: ${err.message}`));
});

/**
 * Boot entry point — registers the cron once at startup if backup is
 * configured, then checks for a missed slot (#8456) — the daemon being down
 * or crash-looping across the scheduled time. Later enable/disable/cron edits
 * are picked up by the `settings:updated` subscription above, which never
 * re-arms a catch-up.
 */
export async function startBackupScheduler() {
  return syncBackupSchedule(undefined, { catchUpMissedSlot: true });
}

/**
 * Stop the backup scheduler by cancelling the scheduled event.
 */
export function stopBackupScheduler() {
  cancel(EVENT_ID);
  reconciliationState = null;
  if (corruptRetryTimer) {
    clearTimeout(corruptRetryTimer);
    corruptRetryTimer = null;
  }
  if (catchUpTimer) {
    clearTimeout(catchUpTimer);
    catchUpTimer = null;
  }
  catchUpEvaluated = false;
  console.log('💾 Backup scheduler: stopped');
}
