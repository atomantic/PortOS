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
vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  getEvent: vi.fn(() => null),
  parseCronToNextRun: vi.fn(),
  parseRecurrenceToNextRun: vi.fn(),
}));
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
});
