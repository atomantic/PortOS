/**
 * Tests for the shared daily-reminder machinery: the half that used to be
 * duplicated between the POST reminder and the autobiography story prompt.
 *
 * Covered here ONCE, through a synthetic feature, so the rules can't drift
 * between the two real ones: when a cron is registered at all (feature flag,
 * `reminder.enabled`, a malformed time), the fire-time re-reads, the day-scoped
 * duplicate guard, the missed-slot catch-up and both of its `updatedAt` floors
 * (#2015, #2040), and the two re-registration paths. Each real reminder's own
 * suite then covers only what is specific to it.
 *
 * The timezone helpers are deliberately NOT mocked — the local-day arithmetic
 * is the thing under test, and a stub would assert nothing about it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settingsEventEmitter = vi.hoisted(() => {
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { (listeners[event] || []).forEach(fn => fn(...args)); },
  };
});
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
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock('./notifications.js', () => ({
  getNotifications: vi.fn().mockResolvedValue([]),
}));
vi.mock('./settings.js', () => ({ settingsEvents: settingsEventEmitter }));

const { schedule, cancel, parseCronToPrevRun } = await import('./eventScheduler.js');
const { getUserTimezone, getTimezoneUpdatedAt } = await import('./userTimezone.js');
const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
const { getNotifications } = await import('./notifications.js');
const { createDailyReminderScheduler } = await import('./dailyReminderScheduler.js');

const EVENT_ID = 'test-daily-reminder';
const readReminderSlice = vi.fn();
const alreadyHandledToday = vi.fn();
const notify = vi.fn();

const scheduler = createDailyReminderScheduler({
  id: EVENT_ID,
  logPrefix: '🧪 Test reminder',
  featureId: 'test-feature',
  notificationType: 'test_reminder',
  readReminderSlice,
  alreadyHandledToday,
  notify,
  configEvents: { emitter: configEventEmitter, event: 'test-config:updated' }
});

// Only Date is faked — `vi.waitFor` in the re-registration tests needs real
// timers, and the rest only needs a fixed "now".
const freezeClock = (iso) => vi.useFakeTimers({ now: new Date(iso), toFake: ['Date'] });

beforeEach(() => {
  scheduler.stop();
  vi.clearAllMocks();
  isInstanceFeatureEnabled.mockResolvedValue(true);
  getUserTimezone.mockResolvedValue('UTC');
  getTimezoneUpdatedAt.mockResolvedValue(null);
  getNotifications.mockResolvedValue([]);
  parseCronToPrevRun.mockReturnValue(null);
  readReminderSlice.mockResolvedValue({ enabled: true, time: '09:00' });
  alreadyHandledToday.mockResolvedValue(false);
  notify.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('register', () => {
  it('registers a daily cron at the configured local time', async () => {
    await scheduler.register();

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: EVENT_ID, type: 'cron', cron: '0 9 * * *', timezone: 'UTC'
    });
  });

  it('cancels instead of scheduling when the instance feature is off', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    await scheduler.register();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(EVENT_ID);
    // The feature flag short-circuits before the config is even read.
    expect(readReminderSlice).not.toHaveBeenCalled();
  });

  it('cancels instead of scheduling when the reminder is disabled (the default)', async () => {
    readReminderSlice.mockResolvedValue({ enabled: false, time: '09:00' });

    await scheduler.register();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(EVENT_ID);
  });

  it('cancels when the reminder slice is entirely absent', async () => {
    readReminderSlice.mockResolvedValue(undefined);

    await scheduler.register();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(EVENT_ID);
  });

  it('refuses a malformed time rather than registering a bad cron', async () => {
    readReminderSlice.mockResolvedValue({ enabled: true, time: '9:00' });

    await scheduler.register();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(EVENT_ID);
  });

  it('re-registers under the same id rather than accumulating registrations', async () => {
    await scheduler.register();
    readReminderSlice.mockResolvedValue({ enabled: true, time: '18:30' });
    await scheduler.register();

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[1][0]).toMatchObject({ id: EVENT_ID, cron: '30 18 * * *' });
  });

  it('does not look for a missed slot unless catch-up was requested', async () => {
    await scheduler.register();

    expect(parseCronToPrevRun).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('fire', () => {
  beforeEach(() => {
    freezeClock('2026-07-01T12:00:00.000Z');
  });

  it('notifies when the thing is still outstanding today', async () => {
    await scheduler.fire();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(alreadyHandledToday).toHaveBeenCalledWith({ timezone: 'UTC', todayStr: '2026-07-01' });
  });

  it('stays silent when the feature was turned off since registration', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    await scheduler.fire();

    expect(notify).not.toHaveBeenCalled();
    expect(readReminderSlice).not.toHaveBeenCalled();
  });

  it('re-reads config at fire time so a disable since registration is respected', async () => {
    readReminderSlice.mockResolvedValue({ enabled: false, time: '09:00' });

    await scheduler.fire();

    expect(notify).not.toHaveBeenCalled();
    expect(alreadyHandledToday).not.toHaveBeenCalled();
  });

  it('stays silent when the feature says today is already handled', async () => {
    alreadyHandledToday.mockResolvedValue(true);

    await scheduler.fire();

    expect(notify).not.toHaveBeenCalled();
  });

  it('does not nudge twice for the same local day', async () => {
    getNotifications.mockResolvedValue([{ timestamp: '2026-07-01T09:00:05.000Z' }]);

    await scheduler.fire();

    expect(notify).not.toHaveBeenCalled();
  });

  // Regression: the guard must be DAY-scoped, not "has this type ever been
  // sent". `notifications.exists(type)` matches any notification of the type
  // ever created, which would silence a daily reminder permanently after its
  // very first nudge.
  it('nudges again the next day, even though yesterday\'s notification still exists', async () => {
    getNotifications.mockResolvedValue([
      { timestamp: '2026-06-30T09:00:05.000Z' },
      { timestamp: '2026-06-29T09:00:05.000Z' }
    ]);

    await scheduler.fire();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('judges "today" by the local calendar day, not the UTC one', async () => {
    // 2026-07-01T12:00Z is 05:00 on the 1st in Los Angeles. A notification
    // stamped 2026-07-01T04:00Z is 21:00 on JUNE 30 there — yesterday for this
    // user — so today's nudge must still go out. Comparing raw UTC dates would
    // see two 2026-07-01 stamps and suppress it.
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    getNotifications.mockResolvedValue([{ timestamp: '2026-07-01T04:00:00.000Z' }]);

    await scheduler.fire();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(alreadyHandledToday).toHaveBeenCalledWith({
      timezone: 'America/Los_Angeles', todayStr: '2026-07-01'
    });
  });
});

describe('missed-slot catch-up', () => {
  beforeEach(() => {
    freezeClock('2026-07-01T12:00:00.000Z');
  });

  it('fires for a slot that already elapsed today', async () => {
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no prior occurrence at all', async () => {
    parseCronToPrevRun.mockReturnValue(null);

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
    expect(alreadyHandledToday).not.toHaveBeenCalled();
  });

  // parseCronToPrevRun always returns SOME past occurrence — for a 09:00
  // reminder booted at 07:00 that is YESTERDAY's slot, which already fired last
  // night. Without the local-day gate, every boot before the scheduled hour
  // would send a spurious nudge.
  it('skips a slot that fell on a previous local day', async () => {
    parseCronToPrevRun.mockReturnValue(new Date('2026-06-30T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
    expect(alreadyHandledToday).not.toHaveBeenCalled();
  });

  it('skips a slot that predates the reminder config change that owns it', async () => {
    readReminderSlice.mockResolvedValue({ enabled: true, time: '09:00', updatedAt: '2026-07-01T10:00:00.000Z' });
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
  });

  it('fires for a slot that postdates the reminder config change', async () => {
    readReminderSlice.mockResolvedValue({ enabled: true, time: '09:00', updatedAt: '2026-06-01T00:00:00.000Z' });
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps plain catch-up on a config saved before updatedAt existed', async () => {
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  // #2040: a zone switch can make today's slot newly appear elapsed, and a
  // restart before the next natural tick would replay an occurrence that was
  // never scheduled under the zone active when it "happened".
  it('skips a slot that predates the last global timezone change', async () => {
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));
    getTimezoneUpdatedAt.mockResolvedValue(Date.parse('2026-07-01T10:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
  });

  it('fires for a slot that postdates the last global timezone change', async () => {
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));
    getTimezoneUpdatedAt.mockResolvedValue(Date.parse('2026-06-01T00:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('uses the LATER of the two cutoffs — timezone wins', async () => {
    readReminderSlice.mockResolvedValue({ enabled: true, time: '09:00', updatedAt: '2026-07-01T08:00:00.000Z' });
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));
    getTimezoneUpdatedAt.mockResolvedValue(Date.parse('2026-07-01T10:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the LATER of the two cutoffs — reminder config wins', async () => {
    readReminderSlice.mockResolvedValue({ enabled: true, time: '09:00', updatedAt: '2026-07-01T10:00:00.000Z' });
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));
    getTimezoneUpdatedAt.mockResolvedValue(Date.parse('2026-07-01T08:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
  });

  it('is idempotent — catch-up still respects the already-handled-today gate', async () => {
    alreadyHandledToday.mockResolvedValue(true);
    parseCronToPrevRun.mockReturnValue(new Date('2026-07-01T09:00:00.000Z'));

    await scheduler.register({ catchUpMissedSlot: true });

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('reconcile via settingsEvents', () => {
  it('reschedules when the global timezone changes', async () => {
    await scheduler.register();
    schedule.mockClear();
    getUserTimezone.mockResolvedValue('America/Los_Angeles');

    settingsEventEmitter.emit('settings:updated');

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0][0]).toMatchObject({ timezone: 'America/Los_Angeles' });
  });

  it('does not reschedule when the effective timezone is unchanged', async () => {
    await scheduler.register();
    schedule.mockClear();

    settingsEventEmitter.emit('settings:updated');

    await new Promise(resolve => setImmediate(resolve));
    expect(schedule).not.toHaveBeenCalled();
  });

  // AGENTS.md: a feature toggle that arms background work must reconcile it at
  // toggle time, not only at boot. Turning the instance feature off has to
  // cancel a live registration on the same `settings:updated` event the toggle
  // rides, rather than leaving the cron armed until the next restart.
  it('cancels a live registration when the instance feature is turned off', async () => {
    await scheduler.register();
    cancel.mockClear();
    isInstanceFeatureEnabled.mockResolvedValue(false);

    settingsEventEmitter.emit('settings:updated');

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(EVENT_ID));
  });

  it('re-arms after a disable/re-enable cycle', async () => {
    await scheduler.register();
    isInstanceFeatureEnabled.mockResolvedValue(false);
    settingsEventEmitter.emit('settings:updated');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(EVENT_ID));

    schedule.mockClear();
    isInstanceFeatureEnabled.mockResolvedValue(true);
    settingsEventEmitter.emit('settings:updated');

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  });

  it('does nothing when the reminder itself is disabled', async () => {
    readReminderSlice.mockResolvedValue({ enabled: false, time: '09:00' });

    settingsEventEmitter.emit('settings:updated');

    await new Promise(resolve => setImmediate(resolve));
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('reschedule via the feature\'s config events', () => {
  it('reschedules when the saved patch touches the reminder slice', async () => {
    configEventEmitter.emit('test-config:updated', { updates: { reminder: { time: '07:30' } } });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  });

  it('ignores a saved patch that does not touch the reminder slice', async () => {
    configEventEmitter.emit('test-config:updated', { updates: { somethingElse: true } });

    await new Promise(resolve => setImmediate(resolve));
    expect(schedule).not.toHaveBeenCalled();
    expect(readReminderSlice).not.toHaveBeenCalled();
  });
});

describe('stop', () => {
  it('cancels the registration', () => {
    scheduler.stop();

    expect(cancel).toHaveBeenCalledWith(EVENT_ID);
  });
});
