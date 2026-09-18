/**
 * Autobiography Daily Story Prompt Scheduler
 *
 * Optional, opt-in (default OFF) scheduled nudge: at a user-chosen time of day
 * it sends a single in-app notification offering a few story ideas, unless the
 * user already wrote a story today. Deterministic — the ideas come from the
 * on-disk prompt bank and nothing here calls an AI provider, so it is safe on a
 * cold install; the storytelling-craft evaluation is a separate, explicitly
 * user-triggered button.
 *
 * All the scheduling machinery — cron registration, the feature gate, the
 * fire-time re-read, the day-scoped duplicate guard, the missed-slot catch-up
 * and its `updatedAt` floors, the timezone reconcile — lives in
 * dailyReminderScheduler.js. This module is the two things that are actually
 * specific to autobiography: what "already handled today" means (a story was
 * written) and what the nudge is.
 */

import { createDailyReminderScheduler } from './dailyReminderScheduler.js';
import { isLocalDay } from '../lib/timezone.js';
import { NOTIFICATION_TYPES } from './notifications.js';
import { getConfig, getStories, sendStoryPrompt, autobiographyConfigEvents } from './autobiography.js';

export const AUTOBIOGRAPHY_REMINDER_EVENT_ID = 'autobiography-daily-prompt';

const scheduler = createDailyReminderScheduler({
  id: AUTOBIOGRAPHY_REMINDER_EVENT_ID,
  logPrefix: '📖 Autobiography reminder',
  source: 'autobiographyReminder',
  featureId: 'autobiography',
  notificationType: NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT,
  readReminderSlice: async () => (await getConfig()).reminder,
  // Story `createdAt` is a precise UTC instant, so the local day comes straight
  // from it rather than from any coarser bucket.
  alreadyHandledToday: async ({ timezone, todayStr }) => {
    const stories = await getStories();
    return stories.some(s => isLocalDay(s?.createdAt, timezone, todayStr));
  },
  notify: async () => {
    const result = await sendStoryPrompt();
    if (!result.prompted) {
      console.log(`📖 Autobiography reminder: no nudge (${result.reason})`);
    }
  },
  configEvents: { emitter: autobiographyConfigEvents, event: 'autobiography-config:updated' }
});

export const fireStoryPromptIfNoStoryToday = scheduler.fire;
export const registerAutobiographyReminderSchedule = scheduler.register;
export const stopAutobiographyReminderSchedule = scheduler.stop;
