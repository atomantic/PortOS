/**
 * Tests for the autobiography story prompt's own contract. The scheduling
 * machinery — registration gates, catch-up floors, day-scoped de-dupe,
 * reconcile — is shared and covered once in dailyReminderScheduler.test.js;
 * what's left here is what only this reminder decides: that "already handled
 * today" means a story was written on the user's LOCAL calendar day, and that
 * the nudge is the shared story-prompt sender.
 *
 * The timezone helpers are deliberately real — the UTC-instant-to-local-day
 * derivation is the thing under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settingsEventEmitter = vi.hoisted(() => ({ on() {}, emit() {} }));
const configEventEmitter = vi.hoisted(() => {
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { (listeners[event] || []).forEach(fn => fn(...args)); },
  };
});

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  parseCronToPrevRun: vi.fn()
}));
vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getTimezoneUpdatedAt: vi.fn().mockResolvedValue(null),
}));
vi.mock('./autobiography.js', () => ({
  getConfig: vi.fn(),
  getStories: vi.fn(),
  sendStoryPrompt: vi.fn(),
  autobiographyConfigEvents: configEventEmitter
}));
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock('./notifications.js', () => ({
  getNotifications: vi.fn().mockResolvedValue([]),
  NOTIFICATION_TYPES: { AUTOBIOGRAPHY_PROMPT: 'autobiography_prompt' }
}));
vi.mock('./settings.js', () => ({ settingsEvents: settingsEventEmitter }));

const { schedule, cancel } = await import('./eventScheduler.js');
const { getUserTimezone } = await import('./userTimezone.js');
const { getConfig, getStories, sendStoryPrompt } = await import('./autobiography.js');
const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
const { getNotifications } = await import('./notifications.js');
const {
  registerAutobiographyReminderSchedule,
  fireStoryPromptIfNoStoryToday,
  stopAutobiographyReminderSchedule,
  AUTOBIOGRAPHY_REMINDER_EVENT_ID
} = await import('./autobiographyReminder.js');

beforeEach(() => {
  stopAutobiographyReminderSchedule();
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-07-01T12:00:00.000Z'), toFake: ['Date'] });
  isInstanceFeatureEnabled.mockResolvedValue(true);
  getUserTimezone.mockResolvedValue('UTC');
  getNotifications.mockResolvedValue([]);
  getStories.mockResolvedValue([]);
  sendStoryPrompt.mockResolvedValue({ prompted: true, prompt: { id: 'childhood-0' } });
  getConfig.mockResolvedValue({ enabled: false, intervalHours: 24, reminder: { enabled: true, time: '09:00' } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fireStoryPromptIfNoStoryToday', () => {
  it('sends the story prompt when nothing was written today', async () => {
    getStories.mockResolvedValue([{ createdAt: '2026-06-20T12:00:00.000Z' }]);

    await fireStoryPromptIfNoStoryToday();

    expect(sendStoryPrompt).toHaveBeenCalledTimes(1);
  });

  it('stays silent when a story was already written today', async () => {
    getStories.mockResolvedValue([{ createdAt: '2026-07-01T08:00:00.000Z' }]);

    await fireStoryPromptIfNoStoryToday();

    expect(sendStoryPrompt).not.toHaveBeenCalled();
  });

  it('ignores a story missing createdAt rather than crashing', async () => {
    getStories.mockResolvedValue([{ id: 's1' }]);

    await fireStoryPromptIfNoStoryToday();

    expect(sendStoryPrompt).toHaveBeenCalledTimes(1);
  });

  // Regression: "written today" is the user's LOCAL day. Now is 05:00 on July 1
  // in Los Angeles; a story stamped 2026-07-01T04:00Z was written at 21:00 on
  // JUNE 30 there — yesterday — so today's prompt must still go out. Comparing
  // raw UTC dates would see two 2026-07-01 stamps and skip it every morning in
  // the Americas.
  it('judges "written today" by the local calendar day, not the UTC one', async () => {
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    getStories.mockResolvedValue([{ createdAt: '2026-07-01T04:00:00.000Z' }]);

    await fireStoryPromptIfNoStoryToday();

    expect(sendStoryPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('registerAutobiographyReminderSchedule', () => {
  it('registers under the autobiography reminder id at the configured time', async () => {
    await registerAutobiographyReminderSchedule();

    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: AUTOBIOGRAPHY_REMINDER_EVENT_ID, cron: '0 9 * * *', timezone: 'UTC'
    });
  });

  it('stays silent on an install where the autobiography feature is off', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    await registerAutobiographyReminderSchedule();

    expect(isInstanceFeatureEnabled).toHaveBeenCalledWith('autobiography');
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(AUTOBIOGRAPHY_REMINDER_EVENT_ID);
  });

  it('reschedules when updateConfig saves a reminder change', async () => {
    configEventEmitter.emit('autobiography-config:updated', {
      updates: { reminder: { time: '07:30' } }
    });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  });
});
