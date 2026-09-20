/**
 * MeatSpace POST Daily Reminder Scheduler
 *
 * Optional, opt-in (default OFF) scheduled nudge: fires a single deterministic
 * (no LLM) in-app notification at a user-chosen time-of-day when today's POST
 * (Power On Self Test) session is still incomplete.
 *
 * All the scheduling machinery — cron registration, the feature gate, the
 * fire-time re-read, the day-scoped duplicate guard, the missed-slot catch-up
 * and its `updatedAt` floors, the timezone reconcile — lives in
 * dailyReminderScheduler.js. This module is the two things that are actually
 * specific to POST: what "already handled today" means (today's session
 * completed) and what the nudge says.
 */

import { createDailyReminderScheduler } from './dailyReminderScheduler.js';
import { isLocalDay } from '../lib/timezone.js';
import { getPostConfig, getPostSessions, postConfigEvents } from './meatspacePost.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { claimQueueDelivery } from './reviewQueueDelivery.js';

export const POST_REMINDER_EVENT_ID = 'post-daily-reminder';

const scheduler = createDailyReminderScheduler({
  id: POST_REMINDER_EVENT_ID,
  logPrefix: '🔔 POST reminder',
  source: 'meatspacePostReminder',
  featureId: 'post',
  notificationType: NOTIFICATION_TYPES.DAILY_POST_REMINDER,
  readReminderSlice: async () => (await getPostConfig()).reminder,
  // Sessions are day-bucketed server-side via `session.date`, stamped from the
  // raw UTC date — a bucket that does NOT line up with local calendar days in
  // any non-UTC zone. So the local day is derived from each session's precise
  // `startedAt` instead, which is correct whatever time of day, relative to
  // either boundary, a session actually completed.
  alreadyHandledToday: async ({ timezone, todayStr }) => {
    const sessions = await getPostSessions();
    return sessions.some(s => isLocalDay(s?.startedAt, timezone, todayStr));
  },
  notify: async ({ todayStr }) => {
    const delivery = await claimQueueDelivery('product:daily-post', 'scheduled', todayStr);
    if (!delivery.claimed) return;
    await addNotification({
      type: NOTIFICATION_TYPES.DAILY_POST_REMINDER,
      title: "Today's POST is still open",
      description: "You haven't completed a Power On Self Test session today — a quick one keeps your streak alive.",
      priority: PRIORITY_LEVELS.LOW,
      link: '/post/launcher',
      metadata: { actionId: 'product:daily-post', occurrence: todayStr },
    });
    console.log(`🔔 POST reminder: nudge sent (today's session incomplete)`);
  },
  configEvents: { emitter: postConfigEvents, event: 'post-config:updated' }
});

export const firePostReminderIfIncomplete = scheduler.fire;
export const registerPostReminderSchedule = scheduler.register;
export const stopPostReminderSchedule = scheduler.stop;
