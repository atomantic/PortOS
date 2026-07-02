/**
 * Tests for meatspacePostReminder — the opt-in (default OFF) daily reminder
 * for POST sessions. Covers: the pure HH:MM -> cron conversion, that the
 * scheduler only registers when enabled, that it reschedules (not
 * double-registers) on repeated calls, that the fired handler only sends a
 * notification when today's session is genuinely incomplete AND it hasn't
 * already notified today, the missed-slot catch-up on server restart, the
 * timezone-change refresh via settingsEvents, and the centralized
 * reschedule-on-save via meatspacePost.js's postConfigEvents (#2015).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal EventEmitter stubs so `<emitter>.on(...)` at module-load time works
// and tests can `.emit(...)` to drive the subscription paths directly —
// mirrors sharing/annotationIdentity.test.js's settingsEvents stub.
const settingsEventEmitter = vi.hoisted(() => {
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { (listeners[event] || []).forEach(fn => fn(...args)); },
  };
});

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

vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getLocalParts: vi.fn(),
  todayInTimezone: vi.fn(),
  HHMM_STRICT_RE: /^([01]\d|2[0-3]):[0-5]\d$/
}));

vi.mock('./meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  getPostSessions: vi.fn(),
  postConfigEvents: postConfigEventEmitter
}));

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({ id: 'n1' }),
  getNotifications: vi.fn().mockResolvedValue([]),
  NOTIFICATION_TYPES: { DAILY_POST_REMINDER: 'daily_post_reminder' },
  PRIORITY_LEVELS: { LOW: 'low' }
}));

vi.mock('./settings.js', () => ({
  settingsEvents: settingsEventEmitter
}));

import { schedule, cancel, parseCronToPrevRun } from './eventScheduler.js';
import { getUserTimezone, getLocalParts, todayInTimezone } from '../lib/timezone.js';
import { getPostConfig, getPostSessions } from './meatspacePost.js';
import { addNotification, getNotifications } from './notifications.js';
import {
  reminderTimeToCron,
  registerPostReminderSchedule,
  firePostReminderIfIncomplete,
  stopPostReminderSchedule,
  POST_REMINDER_EVENT_ID
} from './meatspacePostReminder.js';

describe('reminderTimeToCron', () => {
  it('converts HH:MM to a daily cron expression', () => {
    expect(reminderTimeToCron('09:30')).toBe('30 9 * * *');
    expect(reminderTimeToCron('00:00')).toBe('0 0 * * *');
    expect(reminderTimeToCron('23:59')).toBe('59 23 * * *');
  });

  it('returns null for malformed or missing input', () => {
    expect(reminderTimeToCron('9:30')).toBeNull();
    expect(reminderTimeToCron('25:00')).toBeNull();
    expect(reminderTimeToCron('not-a-time')).toBeNull();
    expect(reminderTimeToCron(undefined)).toBeNull();
    expect(reminderTimeToCron(null)).toBeNull();
  });
});

describe('registerPostReminderSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserTimezone.mockResolvedValue('UTC');
    parseCronToPrevRun.mockReturnValue(null);
  });

  it('cancels the schedule and does not register when disabled (default off)', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: false, time: '09:00' } });
    await registerPostReminderSchedule();
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(POST_REMINDER_EVENT_ID);
  });

  it('cancels and skips scheduling when the reminder block is entirely absent', async () => {
    getPostConfig.mockResolvedValue({});
    await registerPostReminderSchedule();
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(POST_REMINDER_EVENT_ID);
  });

  it('registers a daily cron at the configured time when enabled', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    await registerPostReminderSchedule();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: POST_REMINDER_EVENT_ID,
      type: 'cron',
      cron: '0 9 * * *',
      timezone: 'UTC'
    });
  });

  it('cancels rather than registers when enabled but the time is invalid', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: 'garbage' } });
    await registerPostReminderSchedule();
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(POST_REMINDER_EVENT_ID);
  });

  it('reschedules (re-registers under the same id) rather than accumulating on repeated calls', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    await registerPostReminderSchedule();
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '18:30' } });
    await registerPostReminderSchedule();
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[1][0]).toMatchObject({ id: POST_REMINDER_EVENT_ID, cron: '30 18 * * *' });
  });

  it('does not check for a missed slot unless catchUpMissedSlot is requested', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    await registerPostReminderSchedule();
    expect(parseCronToPrevRun).not.toHaveBeenCalled();
    expect(getPostSessions).not.toHaveBeenCalled();
  });

  // Missed-slot catch-up (finding 2): mirrors taskSchedule.js's
  // parseCronToPrevRun-based recovery — a slot that already elapsed while
  // the server was down fires immediately instead of waiting for tomorrow.
  describe('catchUpMissedSlot: true (boot-time recovery)', () => {
    // Pin the clock so "prevRunMs <= now" comparisons in catchUpMissedSlot
    // are deterministic regardless of what time of day the suite runs.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires the reminder immediately when the most recent cron slot already elapsed today', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
      getPostSessions.mockResolvedValue([]);
      todayInTimezone.mockReturnValue('2026-07-01');
      const missedSlot = new Date('2026-07-01T09:00:00.000Z');
      const dayBefore = new Date('2026-06-30T09:00:00.000Z');
      parseCronToPrevRun.mockReturnValueOnce(missedSlot).mockReturnValueOnce(dayBefore);

      await registerPostReminderSchedule({ catchUpMissedSlot: true });

      expect(addNotification).toHaveBeenCalledTimes(1);
    });

    it('does not fire when there is no elapsed occurrence within the lookback bound', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
      parseCronToPrevRun.mockReturnValue(null);

      await registerPostReminderSchedule({ catchUpMissedSlot: true });

      expect(addNotification).not.toHaveBeenCalled();
      expect(getPostSessions).not.toHaveBeenCalled();
    });

    it('is idempotent — firePostReminderIfIncomplete still skips when today is already complete', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
      todayInTimezone.mockReturnValue('2026-07-01');
      getPostSessions.mockResolvedValue([{ startedAt: '2026-07-01T15:00:00.000Z' }]);
      getLocalParts.mockReturnValue({ year: 2026, month: 7, day: 1 });
      const missedSlot = new Date('2026-07-01T09:00:00.000Z');
      const dayBefore = new Date('2026-06-30T09:00:00.000Z');
      parseCronToPrevRun.mockReturnValueOnce(missedSlot).mockReturnValueOnce(dayBefore);

      await registerPostReminderSchedule({ catchUpMissedSlot: true });

      expect(addNotification).not.toHaveBeenCalled();
    });
  });

  // Timezone refresh (finding 1): a global timezone change elsewhere (not
  // through POST config) must reschedule the cron at the new offset.
  describe('timezone refresh via settingsEvents', () => {
    it('reschedules when the global timezone changes', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
      getUserTimezone.mockResolvedValue('UTC');
      await registerPostReminderSchedule();
      expect(schedule).toHaveBeenCalledTimes(1);

      getUserTimezone.mockResolvedValue('America/Los_Angeles');
      settingsEventEmitter.emit('settings:updated', { timezone: 'America/Los_Angeles' });

      await vi.waitFor(() => {
        expect(schedule).toHaveBeenCalledTimes(2);
      });
      expect(schedule.mock.calls[1][0]).toMatchObject({ timezone: 'America/Los_Angeles' });
    });

    it('does not reschedule when the effective timezone is unchanged', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
      getUserTimezone.mockResolvedValue('UTC');
      await registerPostReminderSchedule();
      expect(schedule).toHaveBeenCalledTimes(1);

      settingsEventEmitter.emit('settings:updated', { timezone: 'UTC' });
      // Flush any pending microtasks from the (no-op) listener before asserting.
      await Promise.resolve();
      await Promise.resolve();

      expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('does not reschedule when the reminder is disabled', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: false, time: '09:00' } });
      settingsEventEmitter.emit('settings:updated', { timezone: 'America/Los_Angeles' });
      await Promise.resolve();
      await Promise.resolve();

      expect(schedule).not.toHaveBeenCalled();
    });
  });

  // Centralized reschedule-on-save (finding 3): meatspacePost.js's
  // updatePostConfig() emits postConfigEvents on every save; this module
  // reschedules whenever the `reminder` slice was part of the patch,
  // regardless of which caller invoked updatePostConfig.
  describe('reschedule via meatspacePost.js postConfigEvents', () => {
    it('reschedules when the saved patch includes a reminder block', async () => {
      getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });

      postConfigEventEmitter.emit('post-config:updated', {
        config: { reminder: { enabled: true, time: '09:00' } },
        updates: { reminder: { enabled: true, time: '09:00' } }
      });

      await vi.waitFor(() => {
        expect(schedule).toHaveBeenCalledTimes(1);
      });
    });

    it('does not reschedule when the saved patch has no reminder key', async () => {
      postConfigEventEmitter.emit('post-config:updated', {
        config: { adaptive: { enabled: true } },
        updates: { adaptive: { enabled: true } }
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(schedule).not.toHaveBeenCalled();
      expect(getPostConfig).not.toHaveBeenCalled();
    });
  });
});

describe('stopPostReminderSchedule', () => {
  it('cancels the reminder event', () => {
    vi.clearAllMocks();
    stopPostReminderSchedule();
    expect(cancel).toHaveBeenCalledWith(POST_REMINDER_EVENT_ID);
  });
});

describe('firePostReminderIfIncomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPostSessions.mockResolvedValue([]);
    getNotifications.mockResolvedValue([]);
    getUserTimezone.mockResolvedValue('UTC');
    todayInTimezone.mockReturnValue('2026-07-01');
    // Default: getLocalParts on any session's startedAt resolves to "today" —
    // individual tests override to simulate a specific local day per session.
    getLocalParts.mockReturnValue({ year: 2026, month: 7, day: 1 });
  });

  it('sends a notification when the reminder is enabled and there are no sessions at all', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([]);

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({
      type: 'daily_post_reminder',
      link: '/post/launcher'
    });
  });

  it('does not nag once a session has been completed today (by local calendar day)', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([{ startedAt: '2026-07-01T15:00:00.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 7, day: 1 });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });

  it('nags when every session on record is from a different local day', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([{ startedAt: '2026-06-30T15:00:00.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 6, day: 30 }); // yesterday, not today

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('ignores a session missing startedAt rather than crashing', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([{ date: '2026-07-01' }]); // no startedAt

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('skips entirely if disabled since registration', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: false, time: '09:00' } });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
    expect(getPostSessions).not.toHaveBeenCalled();
  });

  // De-dupe guard backing the missed-slot catch-up: a second evaluation of
  // the same local day (e.g. catch-up re-running after the normal cron tick
  // already fired earlier) must not send a second notification.
  it('does not nag again if a reminder notification already exists for today', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([]);
    getNotifications.mockResolvedValue([{ timestamp: '2026-07-01T09:00:05.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 7, day: 1 });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });

  it('nags when the only existing reminder notification is from a different local day', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    getPostSessions.mockResolvedValue([]);
    getNotifications.mockResolvedValue([{ timestamp: '2026-06-30T09:00:05.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 6, day: 30 }); // yesterday

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  // Regression (finding 1 + its follow-up): the reminder cron fires on the
  // user's LOCAL wall-clock time, so "is today done" must be evaluated in
  // that same local calendar day. Sessions are day-bucketed server-side via
  // a raw-UTC `session.date` string that does not line up with local
  // calendar days for non-UTC timezones — so this must NOT compare against
  // that bucket at all. Instead it derives each session's local day directly
  // from its precise `startedAt` timestamp, which is correct regardless of
  // what time of day (relative to either the UTC or local day boundary) the
  // session actually completed.
  it("derives 'today' and each session's day from the local timezone, not the raw UTC date/bucket", async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '20:00' } });
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    todayInTimezone.mockReturnValue('2026-07-01');
    // A session with a raw UTC session.date of "2026-07-02" (recorded late in the
    // local evening, after the UTC date had already rolled over) still resolves to
    // local day "2026-07-01" via its precise startedAt timestamp + getLocalParts —
    // proving the check no longer trusts the UTC-dated bucket.
    getPostSessions.mockResolvedValue([{ date: '2026-07-02', startedAt: '2026-07-02T03:30:00.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 7, day: 1 });

    await firePostReminderIfIncomplete();

    expect(getLocalParts).toHaveBeenCalledWith(new Date('2026-07-02T03:30:00.000Z'), 'America/Los_Angeles');
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("zero-pads single-digit month/day when comparing a session's local day", async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    todayInTimezone.mockReturnValue('2026-03-05');
    getPostSessions.mockResolvedValue([{ startedAt: '2026-03-05T12:00:00.000Z' }]);
    getLocalParts.mockReturnValue({ year: 2026, month: 3, day: 5 });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });
});
