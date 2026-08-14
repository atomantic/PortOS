import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EASE,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MAX_QUALITY,
  MIN_EASE,
  advanceSchedule,
  defaultSchedule,
  isSameReviewDay,
  isScheduleDue,
  isValidSchedule,
  mergeScheduleAdvance,
  qualityToRatio,
  ratioToQuality,
  scheduleOrDefault,
} from './spacedRepetition.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');

describe('defaultSchedule', () => {
  it('is due at the anchor instant', () => {
    const schedule = defaultSchedule(NOW.toISOString());
    expect(schedule).toEqual({
      ease: DEFAULT_EASE, intervalDays: 0, nextReview: NOW.toISOString(), lastReviewed: null,
    });
    expect(isScheduleDue(schedule, NOW)).toBe(true);
  });
});

describe('scheduleOrDefault', () => {
  it('returns the stored schedule untouched when it is usable', () => {
    const stored = { ease: 2.1, intervalDays: 9, nextReview: '2026-04-01T00:00:00.000Z' };
    expect(scheduleOrDefault({ schedule: stored })).toBe(stored);
  });

  it('anchors a derived default to the record so two reads agree', () => {
    const record = { updatedAt: '2026-01-05T00:00:00.000Z', createdAt: '2025-12-01T00:00:00.000Z' };
    const first = scheduleOrDefault(record);
    const second = scheduleOrDefault(record);
    // Anchored to updatedAt (not "right now"), so repeated reads are identical
    // and the record reads as due rather than flapping with the clock.
    expect(first.nextReview).toBe('2026-01-05T00:00:00.000Z');
    expect(second).toEqual(first);
    expect(isScheduleDue(first, NOW)).toBe(true);
  });

  it('falls back to createdAt, then to now, and rejects malformed schedules', () => {
    expect(scheduleOrDefault({ createdAt: '2025-12-01T00:00:00.000Z' }).nextReview)
      .toBe('2025-12-01T00:00:00.000Z');
    // A schedule missing nextReview is not "empty", it is unusable — it must not
    // be handed back as if it scheduled anything.
    expect(isValidSchedule({ ease: 2.5, intervalDays: 3 })).toBe(false);
    expect(scheduleOrDefault({ createdAt: '2025-12-01T00:00:00.000Z' }, { ease: 2.5 }).ease)
      .toBe(DEFAULT_EASE);
    expect(typeof scheduleOrDefault({}).nextReview).toBe('string');
  });

  it('reads an explicit schedule argument instead of record.schedule', () => {
    const practice = { ease: 1.9, intervalDays: 4, nextReview: '2026-05-05T00:00:00.000Z' };
    expect(scheduleOrDefault({ schedule: undefined, practice }, practice)).toBe(practice);
  });
});

describe('ratioToQuality / qualityToRatio', () => {
  it('round-trips every integer grade exactly', () => {
    for (let quality = 0; quality <= MAX_QUALITY; quality += 1) {
      expect(ratioToQuality(qualityToRatio(quality))).toBe(quality);
    }
  });

  it('clamps out-of-range and non-finite input to the low end', () => {
    expect(ratioToQuality(2)).toBe(MAX_QUALITY);
    expect(ratioToQuality(-1)).toBe(0);
    // An unmeasurable pass must never read as a perfect one.
    expect(ratioToQuality(undefined)).toBe(0);
    expect(ratioToQuality(NaN)).toBe(0);
    expect(qualityToRatio(99)).toBe(1);
    expect(qualityToRatio(undefined)).toBe(0);
  });
});

describe('advanceSchedule', () => {
  it('steps the interval ladder 0 → 1 → 6 → round(prev * ease)', () => {
    const first = advanceSchedule(defaultSchedule(NOW.toISOString()), 1, NOW);
    expect(first.intervalDays).toBe(1);
    const second = advanceSchedule({ ...first, intervalDays: 1 }, 1, NOW);
    expect(second.intervalDays).toBe(6);
    const third = advanceSchedule({ ease: 2.5, intervalDays: 6, nextReview: NOW.toISOString() }, 1, NOW);
    expect(third.intervalDays).toBe(Math.round(6 * third.ease));
  });

  it('sets nextReview intervalDays into the future and stamps lastReviewed', () => {
    const next = advanceSchedule({ ease: 2.5, intervalDays: 6, nextReview: NOW.toISOString() }, 1, NOW);
    const expected = NOW.getTime() + next.intervalDays * 24 * 60 * 60 * 1000;
    expect(Date.parse(next.nextReview)).toBe(expected);
    expect(next.lastReviewed).toBe(NOW.toISOString());
  });

  it('resets a miss to due-now but still applies the ease penalty', () => {
    const prev = { ease: 2.5, intervalDays: 20, nextReview: NOW.toISOString() };
    const next = advanceSchedule(prev, 0, NOW);
    expect(next.intervalDays).toBe(0);
    expect(next.nextReview).toBe(NOW.toISOString());
    expect(next.ease).toBeLessThan(prev.ease);
  });

  it('clamps ease to the floor and ceiling', () => {
    let schedule = defaultSchedule(NOW.toISOString());
    for (let i = 0; i < 10; i += 1) schedule = advanceSchedule(schedule, 0, NOW);
    expect(schedule.ease).toBe(MIN_EASE);

    schedule = defaultSchedule(NOW.toISOString());
    for (let i = 0; i < 40; i += 1) schedule = advanceSchedule(schedule, 1, NOW);
    expect(schedule.ease).toBe(MAX_EASE);
  });

  it('caps the interval at a year so nextReview can never overflow', () => {
    const huge = advanceSchedule({ ease: 5, intervalDays: 10_000, nextReview: NOW.toISOString() }, 1, NOW);
    expect(huge.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(Number.isNaN(Date.parse(huge.nextReview))).toBe(false);
  });

  it('treats an absent schedule as a fresh one rather than throwing', () => {
    expect(advanceSchedule(undefined, 1, NOW).intervalDays).toBe(1);
  });

  it('is pure — the input schedule is never mutated', () => {
    const prev = { ease: 2.5, intervalDays: 6, nextReview: NOW.toISOString(), lastReviewed: null };
    const snapshot = { ...prev };
    advanceSchedule(prev, 1, NOW);
    expect(prev).toEqual(snapshot);
  });
});

describe('isSameReviewDay', () => {
  it('is true only within the same UTC day', () => {
    expect(isSameReviewDay('2026-03-10T01:00:00.000Z', NOW)).toBe(true);
    expect(isSameReviewDay('2026-03-09T23:59:59.000Z', NOW)).toBe(false);
  });

  it('treats no review history as NOT reviewed today', () => {
    expect(isSameReviewDay(null, NOW)).toBe(false);
    expect(isSameReviewDay(undefined, NOW)).toBe(false);
    expect(isSameReviewDay('not-a-date', NOW)).toBe(false);
  });
});

describe('mergeScheduleAdvance', () => {
  it('lets the first review of the day through', () => {
    const prev = { ease: 2.5, intervalDays: 1, nextReview: NOW.toISOString(), lastReviewed: '2026-03-01T12:00:00.000Z' };
    const advanced = advanceSchedule(prev, 1, NOW);
    expect(mergeScheduleAdvance(prev, advanced, NOW)).toEqual(advanced);
  });

  it('suppresses same-day interval GROWTH but keeps the refreshed ease', () => {
    const prev = { ease: 2.5, intervalDays: 1, nextReview: NOW.toISOString(), lastReviewed: NOW.toISOString() };
    const advanced = advanceSchedule(prev, 1, NOW); // would step 1 → 6
    const merged = mergeScheduleAdvance(prev, advanced, NOW);
    expect(merged.intervalDays).toBe(1);
    expect(merged.nextReview).toBe(prev.nextReview);
    expect(merged.ease).toBe(advanced.ease);
    expect(merged.lastReviewed).toBe(advanced.lastReviewed);
  });

  it('always applies a same-day miss', () => {
    const prev = { ease: 2.5, intervalDays: 6, nextReview: NOW.toISOString(), lastReviewed: NOW.toISOString() };
    const advanced = advanceSchedule(prev, 0, NOW);
    expect(mergeScheduleAdvance(prev, advanced, NOW)).toEqual(advanced);
  });
});

describe('isScheduleDue', () => {
  it('compares nextReview against now', () => {
    expect(isScheduleDue({ nextReview: '2026-03-10T11:59:59.000Z' }, NOW)).toBe(true);
    expect(isScheduleDue({ nextReview: '2026-03-11T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('surfaces a record it cannot schedule rather than hiding it', () => {
    expect(isScheduleDue(undefined, NOW)).toBe(true);
    expect(isScheduleDue({}, NOW)).toBe(true);
    expect(isScheduleDue({ nextReview: 'whenever' }, NOW)).toBe(true);
  });
});
