/**
 * Tests for meatspacePostReminder — the opt-in (default OFF) daily reminder
 * for POST sessions. Covers: the pure HH:MM -> cron conversion, that the
 * scheduler only registers when enabled, that it reschedules (not
 * double-registers) on repeated calls, and that the fired handler only sends
 * a notification when today's session is genuinely incomplete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn()
}));

vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC')
}));

vi.mock('./meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  getPostSessions: vi.fn(),
  computePostStreaks: vi.fn()
}));

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({ id: 'n1' }),
  NOTIFICATION_TYPES: { DAILY_POST_REMINDER: 'daily_post_reminder' },
  PRIORITY_LEVELS: { LOW: 'low' }
}));

import { schedule, cancel } from './eventScheduler.js';
import { getUserTimezone } from '../lib/timezone.js';
import { getPostConfig, getPostSessions, computePostStreaks } from './meatspacePost.js';
import { addNotification } from './notifications.js';
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
  });

  it('sends a notification when the reminder is enabled and today is incomplete', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    computePostStreaks.mockReturnValue({ completedToday: false });

    await firePostReminderIfIncomplete();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({
      type: 'daily_post_reminder',
      link: '/post/launcher'
    });
  });

  it('does not nag once the session is already done today', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
    computePostStreaks.mockReturnValue({ completedToday: true });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });

  it('skips entirely if disabled since registration', async () => {
    getPostConfig.mockResolvedValue({ reminder: { enabled: false, time: '09:00' } });
    computePostStreaks.mockReturnValue({ completedToday: false });

    await firePostReminderIfIncomplete();

    expect(addNotification).not.toHaveBeenCalled();
  });
});
