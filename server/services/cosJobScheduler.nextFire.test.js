/**
 * Interval jobs with a scheduledTime (#15352): the armed timer
 * (registerSingleJobSchedule → computeNextJobFireTime) and the stats preview
 * (computeNextJobRun) must agree, and a run stamped a minute late must not slide
 * a weekly job to the next weekday. Uses the real timezone math; only the heavy
 * CoS collaborators are stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const jobs = new Map();
vi.mock('./autonomousJobs.js', () => ({ getJob: vi.fn(async (id) => jobs.get(id)) }));
// Real cron/recurrence math; only the timer registry is stubbed.
vi.mock('./eventScheduler.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    schedule: vi.fn(),
    cancel: vi.fn(),
    getEvent: vi.fn(() => null),
    parseCronToNextRun: actual.parseCronToNextRun,
    parseRecurrenceToNextRun: actual.parseRecurrenceToNextRun,
  };
});
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles') }));
vi.mock('./cosState.js', () => ({}));
vi.mock('./cosTaskStore.js', () => ({}));
vi.mock('./cosTaskGenerator.js', () => ({}));
vi.mock('./domainUsage.js', () => ({}));
vi.mock('./jobGates.js', () => ({}));
vi.mock('./cosAdmissionReservations.js', () => ({}));
vi.mock('../lib/maintenanceAdmission.js', () => ({}));

import { registerSingleJobSchedule } from './cosJobScheduler.js';
import { schedule as scheduleEvent } from './eventScheduler.js';
import { computeNextJobRun } from './autonomousJobs/scheduler.js';
import { getLocalParts } from '../lib/timezone.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LA = 'America/Los_Angeles';

// Pacific wall-clock instants: PDT (-07:00) until 2026-11-01 02:00, PST (-08:00) after.
const PDT = (iso) => Date.parse(`${iso}-07:00`);
const PST = (iso) => Date.parse(`${iso}-08:00`);

const weekly = (lastRun, scheduledTime = '03:00') => ({
  id: 'job-weekly', interval: 'weekly', intervalMs: 7 * DAY, scheduledTime, lastRun: new Date(lastRun).toISOString(),
});

// Arms the real timer via registerSingleJobSchedule, then requires the stats
// preview to report the same instant, so a drift between them fails every case.
async function nextFire(job) {
  const now = job.lastRun ? Date.parse(job.lastRun) : PDT('2026-10-26T00:00:00');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  jobs.set(job.id, { ...job, enabled: true, name: job.id });
  vi.mocked(scheduleEvent).mockClear();
  await registerSingleJobSchedule(job.id);
  const armed = now + vi.mocked(scheduleEvent).mock.calls[0][0].delayMs;
  expect(computeNextJobRun(job, LA)).toBe(armed);
  return armed;
}

describe('interval job + scheduledTime next fire (#15352)', () => {
  afterEach(() => vi.useRealTimers());

  it('a weekly job finishing a minute after HH:MM stays on the same weekday', async () => {
    const lastRun = PDT('2026-10-26T03:01:00'); // Monday
    expect(await nextFire(weekly(lastRun))).toBe(PST('2026-11-02T03:00:00')); // week spans the fall-back, so 7d 1h of elapsed time
  });

  it('a weekly job finishing a minute before HH:MM also lands on HH:MM next week', async () => {
    const lastRun = PDT('2026-10-26T02:59:00');
    expect(await nextFire(weekly(lastRun))).toBe(PST('2026-11-02T03:00:00'));
  });

  it('does not drift across repeated late runs', async () => {
    let lastRun = PST('2026-11-02T03:01:10'); // Monday
    for (let week = 0; week < 3; week++) {
      const next = await nextFire(weekly(lastRun));
      expect(getLocalParts(new Date(next), LA)).toMatchObject({ dayOfWeek: 1, hour: 3, minute: 0 });
      lastRun = next + 70_000;
    }
  });

  it('keeps 03:00 local on the same weekday across the November DST change', async () => {
    const next = await nextFire(weekly(PDT('2026-10-26T03:01:00'))); // week spans the 2026-11-01 fall-back
    expect(getLocalParts(new Date(next), LA)).toMatchObject({ dayOfWeek: 1, hour: 3, minute: 0 });
    expect(next).toBe(PST('2026-11-02T03:00:00'));
  });

  it('is always later than lastRun, even when the run lands exactly on HH:MM', async () => {
    const lastRun = PDT('2026-10-26T03:00:00');
    expect(await nextFire(weekly(lastRun))).toBeGreaterThan(lastRun);
  });

  it('an hourly job with a time of day resolves to the next HH:MM after lastRun + 1h', async () => {
    const job = (lastRun) => ({ id: 'j', interval: '1h', intervalMs: HOUR, scheduledTime: '03:00', lastRun: new Date(lastRun).toISOString() });
    expect(await nextFire(job(PDT('2026-10-26T10:00:00')))).toBe(PDT('2026-10-27T03:00:00'));
    expect(await nextFire(job(PDT('2026-10-26T01:30:00')))).toBe(PDT('2026-10-26T03:00:00'));
  });

  // No scheduledTime, so the timer takes the interval path (a scheduledTime would make it a cron).
  const dailyWeekdays = (lastRun) => ({ id: 'j', interval: '1d', intervalMs: DAY, weekdaysOnly: true, lastRun: new Date(lastRun).toISOString() });

  it('a weekdaysOnly job skips a weekend spanning the November fall-back and keeps its local hour', async () => {
    // Fri 03:00 PDT + 1d = Sat 2026-10-31 03:00 PDT; the weekend crosses the Nov 1 fall-back.
    // Adding a fixed 48h would land on Monday 02:00 PST.
    const next = await nextFire(dailyWeekdays(PDT('2026-10-30T03:00:00')));
    expect(next).toBe(PST('2026-11-02T03:00:00'));
    expect(getLocalParts(new Date(next), LA)).toMatchObject({ dayOfWeek: 1, hour: 3, minute: 0 });
  });

  it('a weekdaysOnly job skips a weekend spanning the March spring-forward and keeps its local hour', async () => {
    // Fri 03:00 PST + 1d = Sat 2027-03-13 03:00 PST; Sun 03-14 springs forward at 02:00.
    // A fixed 48h would land on Monday 04:00 PDT.
    const next = await nextFire(dailyWeekdays(PST('2027-03-12T03:00:00')));
    expect(next).toBe(PDT('2027-03-15T03:00:00'));
    expect(getLocalParts(new Date(next), LA)).toMatchObject({ dayOfWeek: 1, hour: 3, minute: 0 });
  });

  it('a weekdaysOnly job landing on a Sunday across the fall-back moves one local day to Monday', async () => {
    // Sat 2026-10-31 04:00 PDT + 24h elapsed = Sun 2026-11-01 03:00 PST (the day has 25 hours).
    const next = await nextFire(dailyWeekdays(PDT('2026-10-31T04:00:00')));
    expect(next).toBe(PST('2026-11-02T03:00:00'));
  });

  it('a weekdaysOnly interval job landing on a weekend moves to Monday in both entry points', async () => {
    // No scheduledTime, so the timer takes the interval path (a scheduledTime would make it a cron).
    const job = { id: 'j', interval: '1d', intervalMs: DAY, weekdaysOnly: true, lastRun: new Date(PDT('2026-10-23T12:00:00')).toISOString() };
    expect(await nextFire(job)).toBe(PDT('2026-10-26T12:00:00'));
  });

  it('a daily job with a time of day run manually in the evening fires at HH:MM the next morning in both entry points', async () => {
    const job = { id: 'j', interval: 'daily', intervalMs: DAY, scheduledTime: '03:00', lastRun: new Date(PDT('2026-10-27T20:00:00')).toISOString() };
    expect(await nextFire(job)).toBe(PDT('2026-10-28T03:00:00'));
  });

  it('a weekly weekdaysOnly job with a time of day reports the weekday cron the timer arms', async () => {
    const job = { ...weekly(PDT('2026-10-23T03:01:00')), weekdaysOnly: true }; // Friday
    expect(await nextFire(job)).toBe(PDT('2026-10-26T03:00:00')); // next weekday 03:00
  });

  it('snaps to the nearer HH:MM when a DST change makes the far side of the window nearer than 12h', async () => {
    // Unsnapped due is Sat 2026-10-31 15:15 PDT. Sat 03:00 PDT is 12h15m earlier and
    // Sun 03:00 PST (the day has 25 hours) is 12h45m later, so Saturday is nearest.
    // A one-sided 12h window starts at Sat 03:15 and would skip Saturday.
    const next = await nextFire(weekly(PDT('2026-10-24T15:15:00')));
    expect(next).toBe(PDT('2026-10-31T03:00:00'));
  });

  it('a one-day interval job (not the daily cron path) also gets the full DST window', async () => {
    // 03:00 on Sat Oct 31 (PDT) and Sun Nov 1 (PST) are 25h apart; due Sat 15:15 PDT is
    // 12h15m after the first, so a half-interval (12h) window would pick Sunday.
    const job = { id: 'j', interval: 'custom', intervalMs: DAY, scheduledTime: '03:00', lastRun: new Date(PDT('2026-10-30T15:15:00')).toISOString() };
    expect(await nextFire(job)).toBe(PDT('2026-10-31T03:00:00'));
  });

  it('a job that has never run projects now, not a 1970 instant, and still arms an immediate timer', async () => {
    const now = PDT('2026-10-26T00:00:00');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const job = { id: 'job-never', interval: 'weekly', intervalMs: 7 * DAY, scheduledTime: '03:00', weekdaysOnly: false };
    jobs.set(job.id, { ...job, enabled: true, name: job.id });
    vi.mocked(scheduleEvent).mockClear();
    await registerSingleJobSchedule(job.id);
    expect(vi.mocked(scheduleEvent).mock.calls[0][0].delayMs).toBe(1000);
    expect(computeNextJobRun(job, LA)).toBe(now);
    // Even on a Saturday a weekdaysOnly job that never ran is due now, as before.
    vi.setSystemTime(PDT('2026-10-24T12:00:00'));
    expect(computeNextJobRun({ id: 'j', interval: '1d', intervalMs: DAY, weekdaysOnly: true }, LA)).toBe(PDT('2026-10-24T12:00:00'));
  });
});

// #15395: nearest-slot snapping moves a weekly job to the next weekday once a run is
// stamped >12h after its slot; scheduleAnchor pins the calendar day instead.
describe('anchored multi-day jobs (#15395)', () => {
  afterEach(() => vi.useRealTimers());

  const MONDAY = 1;
  const anchored = (lastRun, overrides = {}) => ({ ...weekly(lastRun), scheduleAnchor: MONDAY, ...overrides });

  it('a weekly 03:00 job anchored on Monday run Monday 20:00 fires next Monday 03:00, across the fall-back', async () => {
    const lastRun = PDT('2026-10-26T20:00:00'); // Monday evening, e.g. a manual run
    expect(await nextFire(anchored(lastRun))).toBe(PST('2026-11-02T03:00:00'));
  });

  it('the same late run without an anchor still takes the nearest slot (Tuesday)', async () => {
    const lastRun = PDT('2026-10-26T20:00:00');
    expect(await nextFire(weekly(lastRun))).toBe(PST('2026-11-03T03:00:00'));
  });

  it('an on-time run lands exactly where nearest-slot snapping put it', async () => {
    const lastRun = PDT('2026-10-26T03:01:00');
    expect(await nextFire(anchored(lastRun))).toBe(await nextFire(weekly(lastRun)));
  });

  it('does not drift to another weekday across repeated runs stamped 17 hours late', async () => {
    let lastRun = PDT('2026-10-26T20:00:00');
    for (let week = 0; week < 5; week++) {
      const next = await nextFire(anchored(lastRun));
      expect(getLocalParts(new Date(next), LA)).toMatchObject({ dayOfWeek: MONDAY, hour: 3, minute: 0 });
      lastRun = next + 17 * HOUR;
    }
  });

  it('a run stamped the evening before the anchor day still waits for the following anchor day', async () => {
    const lastRun = PDT('2026-10-25T22:00:00'); // Sunday evening, 19h before the Monday slot
    expect(await nextFire(anchored(lastRun))).toBe(PST('2026-11-02T03:00:00'));
  });

  it('a run held days past its slot skips an anchor day that is less than a day short of a week away', async () => {
    const lastRun = PDT('2026-10-27T10:00:00'); // Tuesday; next Monday is 6d 17h later
    expect(await nextFire(anchored(lastRun))).toBe(PST('2026-11-09T03:00:00'));
  });

  it('a biweekly job keeps its weekday and fortnight', async () => {
    const job = anchored(PDT('2026-10-19T20:00:00'), { interval: 'biweekly', intervalMs: 14 * DAY });
    expect(await nextFire(job)).toBe(PST('2026-11-02T03:00:00'));
  });

  it('a monthly job keeps its day of month when a short month shifts lastRun + 30 days', async () => {
    const monthly = (lastRun, scheduleAnchor) => ({
      id: 'job-monthly', interval: 'monthly', intervalMs: 30 * DAY, scheduledTime: '03:00', scheduleAnchor, lastRun: new Date(lastRun).toISOString(),
    });
    // Feb 15 + 30d is Mar 17; the 15th must still come next, not April.
    expect(await nextFire(monthly(PST('2027-02-15T03:01:00'), 15))).toBe(PDT('2027-03-15T03:00:00'));
    // A late run on the 15th stays on the 15th of next month.
    expect(await nextFire(monthly(PST('2026-12-15T20:00:00'), 15))).toBe(PST('2027-01-15T03:00:00'));
  });

  it('a monthly day beyond a short month fires on its last day, then returns to the anchor day', async () => {
    const monthly = (lastRun) => ({
      id: 'job-monthly', interval: 'monthly', intervalMs: 30 * DAY, scheduledTime: '03:00', scheduleAnchor: 31, lastRun: new Date(lastRun).toISOString(),
    });
    expect(await nextFire(monthly(PST('2027-01-31T03:01:00')))).toBe(PST('2027-02-28T03:00:00'));
    expect(await nextFire(monthly(PST('2027-02-28T03:01:00')))).toBe(PDT('2027-03-31T03:00:00'));
  });

  it('an anchor that does not fit the cadence is ignored, keeping the nearest-slot behavior', async () => {
    const lastRun = PDT('2026-10-26T20:00:00');
    expect(await nextFire(anchored(lastRun, { scheduleAnchor: 9 }))).toBe(PST('2026-11-03T03:00:00'));
  });
});
