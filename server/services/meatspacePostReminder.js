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
 * registerPostReminderSchedule() is called both at server boot and again after
 * every `PUT /post/config`, so a changed time or enabled flag takes effect on
 * the next tick without a restart (same idea as cosJobScheduler.js's
 * `registerSingleJobSchedule`, simplified since a daily HH:MM nudge doesn't
 * need that module's weekday/interval-fallback machinery).
 */

import { schedule, cancel } from './eventScheduler.js';
import { getUserTimezone } from '../lib/timezone.js';
import { getPostConfig, getPostSessions, computePostStreaks } from './meatspacePost.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';

export const POST_REMINDER_EVENT_ID = 'post-daily-reminder';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Convert an "HH:MM" time-of-day into a daily cron expression ("M H * * *").
 * Pure — exported for unit testing. Returns null for a malformed/missing time
 * so callers can skip scheduling rather than register a bad cron string.
 */
export function reminderTimeToCron(time) {
  if (typeof time !== 'string' || !HHMM_RE.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
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

  const sessions = await getPostSessions();
  const todayStr = new Date().toISOString().split('T')[0];
  const { completedToday } = computePostStreaks(sessions, todayStr);
  if (completedToday) {
    console.log(`🔔 POST reminder: today's session already complete — no nudge`);
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
 * Register (or cancel) the daily reminder cron job from the current POST
 * config. Safe to call repeatedly — `schedule()` replaces any existing
 * registration under the same id, so calling this again after a settings
 * change reschedules immediately.
 */
export async function registerPostReminderSchedule() {
  const config = await getPostConfig();
  const { enabled, time } = config.reminder || {};

  if (!enabled) {
    cancel(POST_REMINDER_EVENT_ID);
    return;
  }

  const cron = reminderTimeToCron(time);
  if (!cron) {
    console.error(`❌ POST reminder: invalid time "${time}" — not scheduling`);
    cancel(POST_REMINDER_EVENT_ID);
    return;
  }

  const timezone = await getUserTimezone();
  schedule({
    id: POST_REMINDER_EVENT_ID,
    type: 'cron',
    cron,
    timezone,
    handler: firePostReminderIfIncomplete,
    metadata: { source: 'meatspacePostReminder' }
  });
  console.log(`🔔 POST reminder: registered daily at ${time} (${timezone})`);
}

/**
 * Cancel the reminder schedule outright (explicit teardown / test cleanup).
 */
export function stopPostReminderSchedule() {
  cancel(POST_REMINDER_EVENT_ID);
}
