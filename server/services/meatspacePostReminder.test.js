/**
 * Tests for the POST daily reminder's own contract. The scheduling machinery —
 * registration gates, catch-up floors, day-scoped de-dupe, reconcile — is
 * shared and covered once in dailyReminderScheduler.test.js; what's left here
 * is what only POST decides: that "already handled today" means a session was
 * started on the user's LOCAL calendar day (not the raw-UTC `session.date`
 * bucket the sessions file is keyed by), and what the nudge itself says.
 *
 * The timezone helpers are deliberately real — the UTC-instant-to-local-day
 * derivation is the thing under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settingsEventEmitter = vi.hoisted(() => ({ on() {}, emit() {} }));
const postConfigEventEmitter = vi.hoisted(() => {
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
vi.mock('./meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  getPostSessions: vi.fn(),
  postConfigEvents: postConfigEventEmitter
}));
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({ id: 'n1' }),
  getNotifications: vi.fn().mockResolvedValue([]),
  NOTIFICATION_TYPES: { DAILY_POST_REMINDER: 'daily_post_reminder' },
  PRIORITY_LEVELS: { LOW: 'low' }
}));
vi.mock('./settings.js', () => ({ settingsEvents: settingsEventEmitter }));

const { schedule, cancel } = await import('./eventScheduler.js');
const { getUserTimezone } = await import('./userTimezone.js');
const { getPostConfig, getPostSessions } = await import('./meatspacePost.js');
const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
const { addNotification, getNotifications } = await import('./notifications.js');
const {
  registerPostReminderSchedule,
  firePostReminderIfIncomplete,
  stopPostReminderSchedule,
  POST_REMINDER_EVENT_ID
} = await import('./meatspacePostReminder.js');

beforeEach(() => {
  stopPostReminderSchedule();
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-07-01T12:00:00.000Z'), toFake: ['Date'] });
  isInstanceFeatureEnabled.mockResolvedValue(true);
  getUserTimezone.mockResolvedValue('UTC');
  getNotifications.mockResolvedValue([]);
  getPostSessions.mockResolvedValue([]);
  getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('firePostReminderIfIncomplete', () => {
  it('nudges to the POST launcher when no session exists at all', async () => {
    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({
      type: 'daily_post_reminder',
      priority: 'low',
      link: '/post/launcher'
    });
  });

  it('does not nag once a session has been started today', async () => {
    getPostSessions.mockResolvedValue([{ startedAt: '2026-07-01T15:00:00.000Z' }]);

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });

  it('nags when every session on record is from a different local day', async () => {
    getPostSessions.mockResolvedValue([{ startedAt: '2026-06-30T15:00:00.000Z' }]);

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('ignores a session missing startedAt rather than crashing', async () => {
    getPostSessions.mockResolvedValue([{ date: '2026-07-01' }]); // no startedAt

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  // Regression: sessions are day-bucketed server-side by a raw-UTC
  // `session.date` string, which for any negative-offset zone rolls over hours
  // before local midnight. The completeness check must derive the local day
  // from the precise `startedAt` instead, or a session finished in that gap is
  // credited to the wrong day.
  it('reads a session\'s local day from startedAt, not its UTC date bucket', async () => {
    // Now is 05:00 on July 1 in Los Angeles. The session's UTC stamp is also
    // July 1, but locally it is 21:00 on JUNE 30 — yesterday — so today is
    // still outstanding and the nudge must go out.
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    getPostSessions.mockResolvedValue([
      { date: '2026-07-01', startedAt: '2026-07-01T04:00:00.000Z' }
    ]);

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });
});

describe('registerPostReminderSchedule', () => {
  it('registers under the POST reminder id at the configured time', async () => {
    await registerPostReminderSchedule();

    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: POST_REMINDER_EVENT_ID, cron: '0 9 * * *', timezone: 'UTC'
    });
  });

  it('stays silent on an install where the POST feature is off', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    await registerPostReminderSchedule();

    expect(isInstanceFeatureEnabled).toHaveBeenCalledWith('post');
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(POST_REMINDER_EVENT_ID);
  });

  // updatePostConfig() emits on every save; the reminder re-registers whenever
  // the `reminder` slice was in the patch, whichever caller saved it (#2015).
  it('reschedules when updatePostConfig saves a reminder change', async () => {
    postConfigEventEmitter.emit('post-config:updated', {
      config: { reminder: { enabled: true, time: '09:00' } },
      updates: { reminder: { enabled: true, time: '09:00' } }
    });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  });
});
