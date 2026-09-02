import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  schedule,
  cancel,
  pause,
  resume,
  getScheduledEvents,
  getEvent,
  getHistory,
  getStats,
  cancelAll,
  triggerNow,
  parseCronToNextRun,
  parseCronToPrevRun,
  isValidCron,
  parseRecurrenceToNextRun,
  isValidRecurrence,
} from './eventScheduler.js';
import { cosEvents } from './cosEvents.js';

// eventScheduler.js's "UTC" branch (the default, and what every consumer below
// uses unless it passes an explicit IANA timezone) reads local Date methods
// (getMonth/getDate/getDay/getHours/getMinutes), not getUTC*. Production always
// runs under PM2 with TZ=UTC (see ecosystem.config.cjs), which makes that local
// time UTC. Pin the same env here so cron matches are deterministic regardless
// of the machine running the tests.
let originalTZ;
beforeAll(() => {
  originalTZ = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// 2024-01-01T00:00:00.000Z is a Monday (getUTCDay()/getDay() under TZ=UTC === 1).
const FIXED_NOW = new Date('2024-01-01T00:00:00.000Z');

// The scheduler's Maps (scheduledEvents/activeTimers) are module-level singleton
// state shared across every test in this file — clear it between tests so cases
// don't leak into each other.
beforeEach(() => {
  cancelAll();
});

// =============================================================================
// isValidCron
// =============================================================================

describe('isValidCron', () => {
  it('accepts a plain 5-field expression', () => {
    expect(isValidCron('5 0 * * *')).toBe(true);
  });

  it('accepts step syntax', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true);
  });

  it('accepts range syntax', () => {
    expect(isValidCron('0 9-17 * * *')).toBe(true);
  });

  it('accepts list syntax', () => {
    expect(isValidCron('0 9,13,17 * * *')).toBe(true);
  });

  it('rejects a minute value of 60 (out of range)', () => {
    expect(isValidCron('60 0 * * *')).toBe(false);
  });

  it('rejects an hour value of 24 (out of range)', () => {
    expect(isValidCron('0 24 * * *')).toBe(false);
  });

  it('rejects a month value of 13 (out of range)', () => {
    expect(isValidCron('0 0 * 13 *')).toBe(false);
  });

  it('rejects a day-of-month value of 0 (below range)', () => {
    expect(isValidCron('0 0 0 * *')).toBe(false);
  });

  it('rejects a malformed field count', () => {
    expect(isValidCron('* * *')).toBe(false);
    expect(isValidCron('* * * * * *')).toBe(false);
  });

  it('rejects non-string and empty input', () => {
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('   ')).toBe(false);
    expect(isValidCron(null)).toBe(false);
    expect(isValidCron(undefined)).toBe(false);
    expect(isValidCron(123)).toBe(false);
  });
});

// =============================================================================
// parseCronToNextRun
// =============================================================================

describe('parseCronToNextRun', () => {
  it('finds the next matching minute later the same day', () => {
    const next = parseCronToNextRun('5 0 * * *', FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-01T00:05:00.000Z');
  });

  it('throws for a malformed field count', () => {
    expect(() => parseCronToNextRun('* * *', FIXED_NOW)).toThrow(/Invalid cron expression/);
  });

  it('returns null for an out-of-range field instead of throwing', () => {
    expect(parseCronToNextRun('60 * * * *', FIXED_NOW)).toBeNull();
  });

  it('resolves step syntax to the next step boundary', () => {
    const next = parseCronToNextRun('*/15 * * * *', FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-01T00:15:00.000Z');
  });

  it('resolves range syntax to the first hour in range', () => {
    const next = parseCronToNextRun('0 9-17 * * *', FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-01T09:00:00.000Z');
  });

  it('resolves list syntax to the next listed minute', () => {
    const next = parseCronToNextRun('0,30 * * * *', FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-01T00:30:00.000Z');
  });

  it('treats day-of-week 7 the same as 0 (Sunday)', () => {
    const asZero = parseCronToNextRun('0 0 * * 0', FIXED_NOW);
    const asSeven = parseCronToNextRun('0 0 * * 7', FIXED_NOW);
    expect(asZero.toISOString()).toBe('2024-01-07T00:00:00.000Z');
    expect(asSeven.toISOString()).toBe(asZero.toISOString());
  });

  it('respects an explicit IANA timezone rather than the process TZ', () => {
    // 09:00 America/New_York on 2024-01-01 (EST, UTC-5) is 14:00 UTC.
    const next = parseCronToNextRun('0 9 * * *', FIXED_NOW, 'America/New_York');
    expect(next.toISOString()).toBe('2024-01-01T14:00:00.000Z');
  });

  it('returns null quickly for an impossible date within a tight until bound', () => {
    // Feb 31st never occurs; bound the search to a few days so it returns null
    // fast instead of scanning the full 2-year window.
    const until = new Date('2024-01-05T00:00:00.000Z');
    expect(parseCronToNextRun('0 0 31 2 *', FIXED_NOW, 'UTC', until)).toBeNull();
  });
});

// =============================================================================
// calendar recurrence scheduling
// =============================================================================

describe('parseRecurrenceToNextRun', () => {
  it('keeps every-two-weeks cadence anchored across a month boundary', () => {
    const next = parseRecurrenceToNextRun({
      frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2024-01-01',
    }, new Date('2024-01-01T03:00:00.000Z'));
    expect(next.toISOString()).toBe('2024-01-15T02:00:00.000Z');
  });

  it('finds the first Thursday of the month', () => {
    const next = parseRecurrenceToNextRun({
      frequency: 'monthly-weekday', ordinal: 'first', weekday: 4, time: '19:00',
    }, FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-04T19:00:00.000Z');
  });

  it('finds the last Thursday of the month', () => {
    const next = parseRecurrenceToNextRun({
      frequency: 'monthly-weekday', ordinal: 'last', weekday: 4, time: '19:00',
    }, FIXED_NOW);
    expect(next.toISOString()).toBe('2024-01-25T19:00:00.000Z');
  });

  it('jumps directly to sparse annual occurrences', () => {
    const next = parseRecurrenceToNextRun({
      frequency: 'monthly-date', interval: 12, dayOfMonth: 1, time: '00:00', anchorDate: '2024-01-01',
    }, new Date('2024-01-02T00:00:00.000Z'));
    expect(next.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('accepts a valid future anchor beyond the runtime two-year horizon', () => {
    const next = parseRecurrenceToNextRun({
      frequency: 'monthly-date', interval: 12, dayOfMonth: 1, time: '00:00', anchorDate: '2027-01-01',
    }, new Date('2024-01-02T00:00:00.000Z'));
    expect(next.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('validates both rich recurrence rules and custom cron rules', () => {
    expect(isValidRecurrence({ frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2024-01-01' })).toBe(true);
    expect(isValidRecurrence({ frequency: 'custom', cron: '*/15 * * * *' })).toBe(true);
    expect(isValidRecurrence({ frequency: 'custom', cron: 'not a cron' })).toBe(false);
    expect(isValidRecurrence({ frequency: 'weekly', weekdays: [], time: '02:00' })).toBe(false);
  });
});

// =============================================================================
// parseCronToPrevRun
// =============================================================================

describe('parseCronToPrevRun', () => {
  it('finds the most recent matching minute at or before `from`', () => {
    const from = new Date('2024-01-01T00:10:00.000Z');
    const prev = parseCronToPrevRun('5 0 * * *', from);
    expect(prev.toISOString()).toBe('2024-01-01T00:05:00.000Z');
  });

  it('returns the exact minute when `from` lands on a match', () => {
    const from = new Date('2024-01-01T00:05:00.000Z');
    const prev = parseCronToPrevRun('5 0 * * *', from);
    expect(prev.toISOString()).toBe('2024-01-01T00:05:00.000Z');
  });

  it('throws for a malformed field count', () => {
    expect(() => parseCronToPrevRun('* * *', FIXED_NOW)).toThrow(/Invalid cron expression/);
  });

  it('returns null for an out-of-range field instead of throwing', () => {
    expect(parseCronToPrevRun('0 25 * * *', FIXED_NOW)).toBeNull();
  });

  it('treats day-of-week 7 the same as 0 (Sunday) walking backward', () => {
    // 2024-01-08 is a Monday; the prior Sunday midnight is 2024-01-07.
    const from = new Date('2024-01-08T12:00:00.000Z');
    const asZero = parseCronToPrevRun('0 0 * * 0', from);
    const asSeven = parseCronToPrevRun('0 0 * * 7', from);
    expect(asZero.toISOString()).toBe('2024-01-07T00:00:00.000Z');
    expect(asSeven.toISOString()).toBe(asZero.toISOString());
  });
});

// =============================================================================
// schedule / cancel / pause / resume lifecycle
// =============================================================================

describe('schedule() validation', () => {
  it('throws when id is missing', () => {
    expect(() => schedule({ type: 'once', delayMs: 1000, handler: () => {} }))
      .toThrow(/requires id, type, and handler/);
  });

  it('throws when handler is missing', () => {
    expect(() => schedule({ id: 'e1', type: 'once', delayMs: 1000 }))
      .toThrow(/requires id, type, and handler/);
  });

  it('throws for an unknown event type', () => {
    expect(() => schedule({ id: 'e1', type: 'bogus', handler: () => {} }))
      .toThrow(/Unknown event type/);
  });

  it('throws when cron type is missing its cron expression', () => {
    expect(() => schedule({ id: 'e1', type: 'cron', handler: () => {} }))
      .toThrow(/requires cron expression/);
  });

  it('throws when interval type is missing intervalMs', () => {
    expect(() => schedule({ id: 'e1', type: 'interval', handler: () => {} }))
      .toThrow(/requires intervalMs/);
  });

  it('throws when once type is missing delayMs', () => {
    expect(() => schedule({ id: 'e1', type: 'once', handler: () => {} }))
      .toThrow(/requires delayMs/);
  });
});

describe('schedule() lifecycle with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    cancelAll();
    vi.useRealTimers();
  });

  it('fires an interval handler on the configured cadence and updates runCount', async () => {
    const handler = vi.fn();
    schedule({ id: 'iv-1', type: 'interval', intervalMs: 5000, handler });

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getEvent('iv-1').runCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getEvent('iv-1').runCount).toBe(2);
  });

  it('fires a once event exactly once and then deactivates it', async () => {
    const handler = vi.fn();
    schedule({ id: 'once-1', type: 'once', delayMs: 1000, handler });

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getEvent('once-1').active).toBe(false);

    await vi.advanceTimersByTimeAsync(10000);
    expect(handler).toHaveBeenCalledTimes(1); // no further runs
  });

  it('fires a cron event at the next matching minute', async () => {
    const handler = vi.fn();
    schedule({ id: 'cron-1', type: 'cron', cron: '* * * * *', handler });

    const event = getEvent('cron-1');
    expect(event.nextRunAt).toBe(new Date('2024-01-01T00:01:00.000Z').getTime());

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fires an anchored recurrence event and re-arms its next occurrence', async () => {
    const handler = vi.fn();
    schedule({
      id: 'recurrence-1',
      type: 'recurrence',
      recurrence: { frequency: 'weekly', interval: 2, weekdays: [1], time: '00:05', anchorDate: '2024-01-01' },
      handler,
    });

    expect(getEvent('recurrence-1').nextRunAt).toBe(new Date('2024-01-01T00:05:00.000Z').getTime());
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getEvent('recurrence-1').nextRunAt).toBe(new Date('2024-01-15T00:05:00.000Z').getTime());
  });

  it('cancel() removes the event and its pending timer stops firing', async () => {
    const handler = vi.fn();
    schedule({ id: 'cancel-1', type: 'once', delayMs: 1000, handler });

    expect(cancel('cancel-1')).toBe(true);
    expect(getEvent('cancel-1')).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancel() returns false for an unknown id', () => {
    expect(cancel('does-not-exist')).toBe(false);
  });

  it('pause() stops the timer without removing the event, resume() restarts it', async () => {
    const handler = vi.fn();
    schedule({ id: 'pause-1', type: 'interval', intervalMs: 5000, handler });

    expect(pause('pause-1')).toBe(true);
    expect(getEvent('pause-1').active).toBe(false);

    await vi.advanceTimersByTimeAsync(20000);
    expect(handler).not.toHaveBeenCalled(); // paused — no runs

    expect(resume('pause-1')).toBe(true);
    expect(getEvent('pause-1').active).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('pause() and resume() return false for an unknown id', () => {
    expect(pause('does-not-exist')).toBe(false);
    expect(resume('does-not-exist')).toBe(false);
  });

  it('triggerNow() runs the handler immediately regardless of nextRunAt', async () => {
    const handler = vi.fn();
    schedule({ id: 'trigger-1', type: 'interval', intervalMs: 60000, handler });

    expect(await triggerNow('trigger-1')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('triggerNow() replaces the pending timer instead of leaving a duplicate run armed', async () => {
    const handler = vi.fn();
    schedule({ id: 'trigger-dup', type: 'interval', intervalMs: 60000, handler });

    expect(await triggerNow('trigger-dup')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getStats().activeTimers).toBe(1);

    // The original 60s deadline must have been cleared by the re-arm, so only the
    // fresh 60s-from-now timer fires in the next minute.
    await vi.advanceTimersByTimeAsync(60000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('triggerNow() does not let the original deadline fire during a long manual run', async () => {
    let release;
    const handler = vi.fn(() => new Promise(resolve => { release = resolve; }));
    schedule({ id: 'trigger-slow', type: 'interval', intervalMs: 60000, handler });

    const running = triggerNow('trigger-slow');
    expect(handler).toHaveBeenCalledTimes(1);

    // Cross the original 60s deadline while the manual run is still in flight
    await vi.advanceTimersByTimeAsync(60000);
    expect(handler).toHaveBeenCalledTimes(1); // no concurrent duplicate run

    release();
    expect(await running).toBe(true);
  });

  it('triggerNow() returns false for an unknown id', async () => {
    expect(await triggerNow('does-not-exist')).toBe(false);
  });

  it('records a failed handler in history without deactivating a recurring event', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    schedule({ id: 'fail-1', type: 'interval', intervalMs: 5000, handler });

    await vi.advanceTimersByTimeAsync(5000);

    const [entry] = getHistory({ eventId: 'fail-1' });
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('boom');
    expect(getEvent('fail-1').active).toBe(true); // still scheduled for next run

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(2); // recurring run still happened
  });

  it('records a successful run in history with a non-negative duration', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    schedule({ id: 'success-1', type: 'once', delayMs: 1000, handler });

    await vi.advanceTimersByTimeAsync(1000);

    const [entry] = getHistory({ eventId: 'success-1' });
    expect(entry.success).toBe(true);
    expect(entry.error).toBeNull();
    expect(entry.duration).toBeGreaterThanOrEqual(0);
  });

  it('re-arms a recurring event even when a scheduler:ran listener throws', async () => {
    // The re-arm used to sit after the emit, outside any try — one throwing
    // listener permanently stopped the schedule while the UI still showed it active.
    const handler = vi.fn();
    const listener = vi.fn(() => { throw new Error('listener boom'); });
    cosEvents.on('scheduler:ran', listener);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      schedule({ id: 'listener-throw', type: 'interval', intervalMs: 5000, handler });

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getEvent('listener-throw').active).toBe(true);
      expect(getStats().activeTimers).toBe(1); // re-armed with a fresh handle

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(2); // schedule survived the throw
    } finally {
      cosEvents.off('scheduler:ran', listener);
      consoleError.mockRestore();
    }
  });

  it('stops a cron event whose expression became unparseable, naming the reason', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // The handler receives the live event object — corrupt the cron mid-run the
      // same way a bad persisted value would surface on the next recompute.
      schedule({
        id: 'bad-cron',
        type: 'cron',
        cron: '* * * * *',
        handler: event => { event.cron = '* * *'; },
      });

      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(getEvent('bad-cron').active).toBe(false);
      expect(getStats().activeTimers).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Event bad-cron could not compute its next run')
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('stops a recurrence event that yields no next occurrence, naming the reason', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      schedule({
        id: 'no-next',
        type: 'recurrence',
        recurrence: { frequency: 'weekly', interval: 1, weekdays: [1], time: '00:05', anchorDate: '2024-01-01' },
        handler: event => { event.recurrence = { frequency: 'weekly', interval: 0 }; },
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(getEvent('no-next').active).toBe(false);
      expect(getStats().activeTimers).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Event no-next has no next run time')
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('cancelAll() removes every scheduled event and reports the count removed', () => {
    schedule({ id: 'a', type: 'once', delayMs: 1000, handler: () => {} });
    schedule({ id: 'b', type: 'once', delayMs: 1000, handler: () => {} });

    expect(getScheduledEvents()).toHaveLength(2);
    expect(cancelAll()).toBe(2);
    expect(getScheduledEvents()).toHaveLength(0);
  });

  it('getStats() reports totals broken down by type', () => {
    schedule({ id: 'stat-a', type: 'once', delayMs: 1000, handler: () => {} });
    schedule({ id: 'stat-b', type: 'interval', intervalMs: 5000, handler: () => {} });
    pause('stat-b');

    const stats = getStats();
    expect(stats.totalEvents).toBe(2);
    expect(stats.activeEvents).toBe(1); // stat-b paused
    expect(stats.byType).toEqual({ once: 1, interval: 1 });
  });
});
