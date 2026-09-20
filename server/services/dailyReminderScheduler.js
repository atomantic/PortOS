/**
 * Daily Reminder Scheduler — the shared machinery behind every opt-in,
 * user-timed "you haven't done X today" nudge.
 *
 * Two features had grown byte-identical copies of this: the POST session
 * reminder and the autobiography story prompt. What actually differs between
 * them is two predicates and a notification; everything else — cron
 * registration, the feature gate, the fire-time re-read, the day-scoped
 * duplicate guard, the missed-slot catch-up and its two `updatedAt` floors, the
 * timezone-change reconcile — is the same code twice, and it is the subtle
 * half. The catch-up floors in particular are bug-fix history (#2015, #2040):
 * duplicated, the third such fix has to be found and made in two places.
 *
 * A feature supplies:
 *   - `alreadyHandledToday({ timezone, todayStr })` — did the user already do
 *     the thing this reminder nags about, on their LOCAL calendar day?
 *   - `notify()` — send the nudge.
 *   - where to read its `{ enabled, time, updatedAt }` slice, and which event
 *     announces a save of it.
 *
 * Nothing here calls an AI provider. A reminder is a deterministic cron nudge,
 * which is what keeps it inside AGENTS.md's AI Provider Usage Policy even
 * before the "user-configured scheduled automation" exception applies.
 */

import { schedule, cancel, parseCronToPrevRun } from './eventScheduler.js';
import { todayInTimezone, isLocalDay, dailyCronFromHHMM } from '../lib/timezone.js';
import { getUserTimezone, getTimezoneUpdatedAt } from './userTimezone.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { getNotifications } from './notifications.js';
import { settingsEvents } from './settings.js';

/**
 * Normalize an ISO string or epoch-ms number to a UTC-ms floor, treating
 * unset/invalid as 0 so it never gates. Sentinel-guarded on purpose: an install
 * that never recorded the value must keep plain catch-up rather than losing it.
 */
function toMs(value) {
  if (!value) return 0;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {Object} spec
 * @param {string} spec.id - eventScheduler registration id (also the cancel key)
 * @param {string} spec.logPrefix - emoji-prefixed label for this reminder's logs
 * @param {string} spec.source - `metadata.source` recorded on the scheduled event
 *   (the declaring module, which is what the scheduler's own error logs name)
 * @param {string} spec.featureId - instance feature that gates the whole reminder
 * @param {() => Promise<{enabled?: boolean, time?: string, updatedAt?: string}>} spec.readReminderSlice
 * @param {string} spec.notificationType - type used for the day-scoped duplicate guard
 * @param {(ctx: {timezone: string, todayStr: string}) => Promise<boolean>} spec.alreadyHandledToday
 * @param {() => Promise<void>} spec.notify
 * @param {{emitter: {on: Function}, event: string}} [spec.configEvents] - save announcement to reconcile on
 * @returns {{eventId: string, fire: Function, register: Function, reconcile: Function, stop: Function}}
 */
export function createDailyReminderScheduler({
  id,
  logPrefix,
  source,
  featureId,
  readReminderSlice,
  notificationType,
  alreadyHandledToday,
  notify,
  configEvents
}) {
  // Timezone actually applied to the current registration — tracked so a global
  // settings save that doesn't touch the timezone (most of them) skips a
  // redundant reschedule + log line. Null whenever nothing is registered, which
  // is also what makes a re-enable reschedule rather than short-circuit.
  let lastAppliedTimezone = null;

  const unregister = () => {
    cancel(id);
    lastAppliedTimezone = null;
  };

  /**
   * Fire the nudge if — and only if — it is still wanted. Re-reads the feature
   * flag and the config at fire time so a disable between registration and the
   * scheduled minute is respected instead of nagging once more.
   */
  async function fire() {
    if (!await isInstanceFeatureEnabled(featureId)) {
      console.log(`${logPrefix}: feature disabled on this instance — skipping`);
      return;
    }

    const slice = await readReminderSlice();
    if (slice?.enabled !== true) {
      console.log(`${logPrefix}: disabled since registration — skipping`);
      return;
    }

    // The cron fires on the user's LOCAL wall-clock time, so every "today" here
    // is their local calendar day, derived from each record's own precise UTC
    // timestamp — never from a coarser UTC-dated bucket, which for any
    // negative-offset zone rolls over hours before local midnight.
    const timezone = await getUserTimezone();
    const todayStr = todayInTimezone(timezone);

    if (await alreadyHandledToday({ timezone, todayStr })) {
      console.log(`${logPrefix}: already handled today — no nudge`);
      return;
    }

    // De-dupe against a nudge already sent today. Without this the missed-slot
    // catch-up (run on every server restart) would re-nag if the server
    // restarts again later the same day after the normal tick already fired —
    // "still outstanding" alone doesn't prove this run is the first one today.
    // Day-scoped rather than `notifications.exists(type)`, which matches ANY
    // notification of the type ever sent: that would silence the reminder
    // permanently after its first nudge.
    const existing = await getNotifications({ type: notificationType });
    if (existing.some(n => isLocalDay(n?.timestamp, timezone, todayStr))) {
      console.log(`${logPrefix}: already notified today — skipping duplicate`);
      return;
    }

    await notify({ timezone, todayStr });
  }

  /**
   * If today's cron slot has already elapsed (the server was down, or just
   * booted after the scheduled minute), fire now instead of waiting for
   * tomorrow.
   *
   * `parseCronToPrevRun` always returns SOME past occurrence — typically last
   * night's, which already fired normally — whenever `now` is earlier in the
   * day than the configured time. A bound expressed in elapsed time can't tell
   * "yesterday's slot, already handled" from "today's slot, genuinely missed",
   * so the gate is whether the occurrence lands on TODAY'S LOCAL CALENDAR DAY.
   *
   * The two floors then refuse a slot the CURRENT configuration never owned:
   *   - `reminder.updatedAt` — enabling the reminder (or changing its time) for
   *     an already-past time today, then restarting later that same day, would
   *     otherwise replay a slot that happened under different, possibly
   *     disabled, settings.
   *   - the global timezone's `updatedAt` (#2040) — switching zones can make
   *     today's slot newly appear elapsed, and a restart before the next
   *     natural tick would replay an occurrence never scheduled under the zone
   *     active when it "happened".
   * Both are sentinel-guarded, so an install that recorded neither keeps the
   * backward-compatible catch-up it already had. `fire` is itself idempotent,
   * so a rare false positive at this gate is safe.
   */
  async function catchUpMissedSlot(cron, timezone, reminderUpdatedAt, timezoneUpdatedAt) {
    const prevRun = parseCronToPrevRun(cron, new Date(), timezone);
    if (!prevRun) return;

    const prevRunMs = prevRun.getTime();
    if (!isLocalDay(prevRunMs, timezone, todayInTimezone(timezone))) return;

    const cutoff = Math.max(toMs(reminderUpdatedAt), toMs(timezoneUpdatedAt));
    if (cutoff && prevRunMs < cutoff) {
      console.log(`${logPrefix}: missed slot (${prevRun.toISOString()}) predates last config/timezone change — skipping catch-up`);
      return;
    }

    console.log(`${logPrefix}: missed slot detected (${prevRun.toISOString()}) — catching up now`);
    await fire();
  }

  /**
   * Register (or cancel) the daily cron from the current config. Safe to call
   * repeatedly — `schedule()` replaces any existing registration under the same
   * id, so this doubles as the reconciler.
   *
   * @param {Object} [options]
   * @param {boolean} [options.catchUpMissedSlot] - Check for and fire a slot
   *   that already elapsed (server-restart recovery). Only the boot-time call
   *   sets this; a reschedule from a config or timezone save must not replay a
   *   slot the user did not miss.
   */
  async function register({ catchUpMissedSlot: shouldCatchUp = false } = {}) {
    if (!await isInstanceFeatureEnabled(featureId)) {
      unregister();
      return;
    }

    const { enabled, time, updatedAt } = await readReminderSlice() || {};
    if (!enabled) {
      unregister();
      return;
    }

    const cron = dailyCronFromHHMM(time);
    if (!cron) {
      console.error(`❌ ${logPrefix}: invalid time "${time}" — not scheduling`);
      unregister();
      return;
    }

    const timezone = await getUserTimezone();
    // Stamped AFTER the registration it describes: if `schedule` throws, the
    // subscriptions catch and log, and a `lastAppliedTimezone` naming a zone
    // that was never applied would make every later reconcile short-circuit —
    // leaving the reminder unregistered until a zone change or a restart.
    schedule({ id, type: 'cron', cron, timezone, handler: fire, metadata: { source } });
    lastAppliedTimezone = timezone;
    console.log(`${logPrefix}: registered daily at ${time} (${timezone})`);

    if (shouldCatchUp) {
      await catchUpMissedSlot(cron, timezone, updatedAt, await getTimezoneUpdatedAt());
    }
  }

  /**
   * Bring the registration back in line with state that changed elsewhere — the
   * feature toggle or the user's GLOBAL timezone. AGENTS.md requires a feature
   * toggle that arms background work to reconcile it at toggle time, not only
   * at boot; both ride the same `settings:updated` event, so this is the one
   * handler for both. It re-registers only when the effective timezone actually
   * changed, so tweaking an unrelated setting doesn't spam a reschedule.
   */
  async function reconcile() {
    if (!await isInstanceFeatureEnabled(featureId)) {
      unregister();
      return;
    }

    const slice = await readReminderSlice();
    if (slice?.enabled !== true) {
      unregister();
      return;
    }

    const timezone = await getUserTimezone();
    // A null `lastAppliedTimezone` means nothing is currently registered (boot,
    // or a cancel from a feature/reminder disable), so this re-arms rather than
    // short-circuiting — that is what makes re-enabling take effect at once.
    if (timezone === lastAppliedTimezone) return;

    console.log(`${logPrefix}: rescheduling (timezone ${lastAppliedTimezone || 'unset'} → ${timezone})`);
    await register();
  }

  settingsEvents.on('settings:updated', () => {
    reconcile().catch(err => console.error(`❌ ${logPrefix} reconcile failed: ${err.message}`));
  });

  // Reschedule-on-save lives here rather than in a route handler so every
  // current and future caller of the feature's config updater gets it for free
  // (#2015). Gated on the `reminder` slice actually being in the patch, so
  // unrelated config saves don't trigger a redundant reschedule + log line.
  if (configEvents) {
    configEvents.emitter.on(configEvents.event, ({ updates } = {}) => {
      if (!updates?.reminder) return;
      register().catch(err => console.error(`❌ ${logPrefix} reschedule failed: ${err.message}`));
    });
  }

  return {
    eventId: id,
    fire,
    register,
    reconcile,
    stop: unregister
  };
}
