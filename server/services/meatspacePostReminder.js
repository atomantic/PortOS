/**
 * MeatSpace POST Daily Reminder Scheduler
 *
 * Optional, opt-in (default OFF) scheduled nudge: fires a single deterministic
 * (no LLM) in-app notification at a user-chosen time-of-day when today's POST
 * (Power On Self Test) session is still incomplete. Nothing here calls an AI
 * provider — the "scheduled automations are user-configured" exception in
 * CLAUDE.md's AI Provider Usage Policy covers this even though it's moot, since
 * this feature makes zero LLM calls of its own.
 *
 * Mirrors backupScheduler.js's daily-cron registration pattern via
 * eventScheduler.js, but — unlike backupScheduler's fixed-at-registration cron
 * expression — the time-of-day is user-editable at runtime:
 * registerPostReminderSchedule() is called at server boot, whenever
 * updatePostConfig() saves a `reminder` change (via meatspacePost.js's
 * postConfigEvents — see below), and whenever the user's global timezone
 * changes (via settings.js's settingsEvents) — so a changed time, enabled
 * flag, or timezone all take effect on the next tick without a restart (same
 * idea as cosJobScheduler.js's `registerSingleJobSchedule`, simplified since
 * a daily HH:MM nudge doesn't need that module's weekday/interval-fallback
 * machinery). The boot-time call additionally checks for a missed slot
 * (mirrors taskSchedule.js's `parseCronToPrevRun` catch-up) so a reminder
 * whose slot elapsed while the server was down still fires once it's back up.
 */

import { schedule, cancel, parseCronToPrevRun } from './eventScheduler.js';
import { getUserTimezone, getLocalParts, todayInTimezone, HHMM_STRICT_RE } from '../lib/timezone.js';
import { getPostConfig, getPostSessions, postConfigEvents } from './meatspacePost.js';
import { addNotification, getNotifications, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { settingsEvents } from './settings.js';

export const POST_REMINDER_EVENT_ID = 'post-daily-reminder';

// Timezone actually applied to the current cron registration — tracked so a
// global settings save that doesn't touch the timezone (most of them) skips
// a redundant reschedule + log line (see settingsEvents subscription below).
// Reset to null whenever the reminder is disabled/unregistered.
let lastAppliedTimezone = null;

/**
 * Convert an "HH:MM" time-of-day into a daily cron expression ("M H * * *").
 * Pure — exported for unit testing. Returns null for a malformed/missing time
 * so callers can skip scheduling rather than register a bad cron string.
 */
export function reminderTimeToCron(time) {
  if (typeof time !== 'string' || !HHMM_STRICT_RE.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

/**
 * True if a UTC timestamp falls on the given "YYYY-MM-DD" LOCAL calendar day
 * (in `timezone`). Shared by both the "did today's session complete" and
 * "did a reminder already go out today" checks below — both need the same
 * UTC-timestamp-to-local-day comparison, just against a different collection.
 */
function isOnLocalDay(timestamp, timezone, dayStr) {
  if (!timestamp) return false;
  const parts = getLocalParts(new Date(timestamp), timezone);
  const localDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return localDate === dayStr;
}

/**
 * Fire the reminder notification if — and only if — today's POST is still
 * incomplete. Re-reads config at fire time (mirrors backupScheduler's
 * re-check) so a disable that happened between registration and the
 * scheduled minute is respected instead of nagging once more.
 */
export async function firePostReminderIfIncomplete() {
  const config = await getPostConfig();
  if (config.reminder?.enabled !== true) {
    console.log(`🔔 POST reminder: disabled since registration — skipping`);
    return;
  }

  // The cron itself fires on the user's LOCAL wall-clock time (registerPostReminderSchedule
  // schedules it with `timezone` from getUserTimezone()), so "today" for the completeness
  // check must be the user's local calendar day. Sessions are day-bucketed server-side via
  // `session.date`, stamped from the raw UTC date (see submitPostSession in meatspacePost.js)
  // — that bucket does NOT line up with local calendar days for any non-UTC timezone, and for
  // negative-UTC-offset zones (the Americas) the UTC date can roll over several hours before
  // local midnight. Comparing against that bucket (even after converting only the "now" side
  // to local time) would still mismatch for a session completed in the gap between the UTC
  // rollover and local midnight. So this derives each session's local day directly from its
  // precise `startedAt` timestamp instead of trusting the coarse UTC-dated bucket at all —
  // correct regardless of what time of day, relative to either boundary, a session actually
  // completed.
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone);
  const sessions = await getPostSessions();
  const completedToday = sessions.some(s => isOnLocalDay(s?.startedAt, timezone, todayStr));
  if (completedToday) {
    console.log(`🔔 POST reminder: today's session already complete — no nudge`);
    return;
  }

  // De-dupe against a notification already sent today. Without this, the
  // missed-slot catch-up (registerPostReminderSchedule, run on every server
  // restart) would re-nag if the server restarts again later the same day
  // after the normal cron tick already fired — "still incomplete" alone
  // isn't enough to guarantee this run is the first one today.
  const existing = await getNotifications({ type: NOTIFICATION_TYPES.DAILY_POST_REMINDER });
  const alreadyNotifiedToday = existing.some(n => isOnLocalDay(n?.timestamp, timezone, todayStr));
  if (alreadyNotifiedToday) {
    console.log(`🔔 POST reminder: already notified today — skipping duplicate`);
    return;
  }

  await addNotification({
    type: NOTIFICATION_TYPES.DAILY_POST_REMINDER,
    title: "Today's POST is still open",
    description: "You haven't completed a Power On Self Test session today — a quick one keeps your streak alive.",
    priority: PRIORITY_LEVELS.LOW,
    link: '/post/launcher'
  });
  console.log(`🔔 POST reminder: nudge sent (today's session incomplete)`);
}

/**
 * If today's cron slot has already elapsed (the server was down or just
 * booted after the scheduled minute), fire the reminder immediately instead
 * of waiting for tomorrow's tick. Mirrors taskSchedule.js's
 * `parseCronToPrevRun`-based catch-up, but — unlike a repeating task with no
 * fixed time-of-day — a daily HH:MM reminder's "was a slot missed" question
 * has an exact answer: is the most recent past occurrence ON TODAY'S LOCAL
 * CALENDAR DAY? `parseCronToPrevRun` always returns SOME past occurrence
 * (typically "last night's", which already fired normally) whenever `now` is
 * earlier in the day than the configured time — a bound expressed only in
 * elapsed time (e.g. "within one cron period") can't distinguish "yesterday's
 * slot, already handled" from "today's slot, genuinely missed," and would
 * wrongly fire on every boot before the scheduled hour. Gating on the local
 * calendar day removes that ambiguity outright. `firePostReminderIfIncomplete`
 * itself is idempotent (completedToday + already-notified-today guards), so
 * calling it here is safe even on a rare false-positive gate.
 */
async function catchUpMissedSlot(cron, timezone) {
  const now = Date.now();
  const prevRun = parseCronToPrevRun(cron, new Date(now), timezone);
  if (!prevRun) return;

  const todayStr = todayInTimezone(timezone);
  if (!isOnLocalDay(prevRun.getTime(), timezone, todayStr)) return;

  console.log(`🔔 POST reminder: missed slot detected (${prevRun.toISOString()}) — catching up now`);
  await firePostReminderIfIncomplete();
}

/**
 * Register (or cancel) the daily reminder cron job from the current POST
 * config. Safe to call repeatedly — `schedule()` replaces any existing
 * registration under the same id, so calling this again after a settings
 * change reschedules immediately.
 *
 * @param {Object} [options]
 * @param {boolean} [options.catchUpMissedSlot] - Check for and fire a slot
 *   that already elapsed (server-restart recovery). Only the boot-time
 *   registration in server/index.js sets this — reschedules triggered by a
 *   config/timezone save should NOT replay a slot the user didn't miss.
 */
export async function registerPostReminderSchedule({ catchUpMissedSlot: shouldCatchUp = false } = {}) {
  const config = await getPostConfig();
  const { enabled, time } = config.reminder || {};

  if (!enabled) {
    cancel(POST_REMINDER_EVENT_ID);
    lastAppliedTimezone = null;
    return;
  }

  const cron = reminderTimeToCron(time);
  if (!cron) {
    console.error(`❌ POST reminder: invalid time "${time}" — not scheduling`);
    cancel(POST_REMINDER_EVENT_ID);
    lastAppliedTimezone = null;
    return;
  }

  const timezone = await getUserTimezone();
  lastAppliedTimezone = timezone;
  schedule({
    id: POST_REMINDER_EVENT_ID,
    type: 'cron',
    cron,
    timezone,
    handler: firePostReminderIfIncomplete,
    metadata: { source: 'meatspacePostReminder' }
  });
  console.log(`🔔 POST reminder: registered daily at ${time} (${timezone})`);

  if (shouldCatchUp) {
    await catchUpMissedSlot(cron, timezone);
  }
}

/**
 * Refresh the cron's timezone when the user's global timezone setting
 * changes elsewhere (Settings page, not this feature's own config) — without
 * this, the reminder keeps firing at the OLD offset until the next unrelated
 * POST-config save happens to reschedule it. Fired on every `settings:updated`
 * event but only actually reschedules (and logs) when the effective timezone
 * changed, so tweaking an unrelated setting doesn't spam a reschedule.
 */
async function refreshTimezoneIfChanged() {
  const config = await getPostConfig();
  if (config.reminder?.enabled !== true) return; // nothing scheduled to refresh

  const timezone = await getUserTimezone();
  if (timezone === lastAppliedTimezone) return;

  console.log(`🔔 POST reminder: timezone changed (${lastAppliedTimezone || 'unset'} → ${timezone}) — rescheduling`);
  await registerPostReminderSchedule();
}

settingsEvents.on('settings:updated', () => {
  refreshTimezoneIfChanged().catch(err => console.error(`❌ POST reminder timezone refresh failed: ${err.message}`));
});

// Centralizes reschedule-on-save inside updatePostConfig() (via its
// postConfigEvents emitter) rather than bolting it onto one route handler —
// any current or future caller of updatePostConfig gets the reschedule for
// free (#2015). Gated on the `reminder` slice actually being part of the
// patch so unrelated config saves (drill settings, adaptive toggle, etc.)
// don't trigger a redundant reschedule + log line.
postConfigEvents.on('post-config:updated', ({ updates }) => {
  if (!updates?.reminder) return;
  registerPostReminderSchedule().catch(err => console.error(`❌ POST reminder reschedule failed: ${err.message}`));
});

/**
 * Cancel the reminder schedule outright (explicit teardown / test cleanup).
 */
export function stopPostReminderSchedule() {
  cancel(POST_REMINDER_EVENT_ID);
  lastAppliedTimezone = null;
}
