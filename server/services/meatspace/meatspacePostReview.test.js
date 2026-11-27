import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock file I/O so the store tests stay pure — one in-memory schedule the mock
// reads/writes, so applySession* → getDueReviews round-trips without touching disk.
let store = { skills: {} };
vi.mock('../../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn((path, data) => { store = data; return Promise.resolve(); }),
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(() => Promise.resolve(structuredClone(store))),
}));

import {
  REVIEW_INTERVALS_DAYS,
  PERMANENT_MASTERY_PASSES,
  REFRESH_INTERVAL_DAYS,
  defaultReviewEntry,
  isReviewDue,
  reviewState,
  applyReviewResult,
  applyPractice,
  retentionForEntry,
  applySessionToReviewSchedule,
  getReviewSchedule,
  getDueReviews,
  getRetentionReport,
} from './meatspacePostReview.js';

const DAY = 86400000;
const skill = (over = {}) => ({ skillId: 'multiplication:L0', kind: 'multiplication', label: 'Multiplication 1×1-digit', drillType: 'multiplication', level: 0, factors: [1, 1], ...over });

beforeEach(() => {
  store = { skills: {} };
  vi.clearAllMocks();
});

describe('defaultReviewEntry', () => {
  it('schedules the first review one (7-day) interval out and starts fresh', () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const entry = defaultReviewEntry(skill(), now);
    expect(entry.status).toBe('fresh');
    expect(entry.reviewStage).toBe(0);
    expect(entry.masteredAt).toBe(now.toISOString());
    expect(Date.parse(entry.nextReviewAt) - now.getTime()).toBe(REVIEW_INTERVALS_DAYS[0] * DAY);
    expect(entry.reviewsTaken).toBe(0);
    expect(entry.verificationPasses).toBe(0);
  });
});

describe('isReviewDue / reviewState', () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  it('fresh before nextReviewAt, due after', () => {
    const fresh = { nextReviewAt: new Date(now.getTime() + DAY).toISOString(), status: 'fresh' };
    const overdue = { nextReviewAt: new Date(now.getTime() - DAY).toISOString(), status: 'fresh' };
    expect(isReviewDue(fresh, now)).toBe(false);
    expect(reviewState(fresh, now)).toBe('fresh');
    expect(isReviewDue(overdue, now)).toBe(true);
    expect(reviewState(overdue, now)).toBe('due');
  });
  it('needs-refresh state wins over fresh/due classification', () => {
    const entry = { nextReviewAt: new Date(now.getTime() + DAY).toISOString(), status: 'needs-refresh' };
    expect(reviewState(entry, now)).toBe('needs-refresh');
  });
  it('treats a missing/invalid nextReviewAt as due', () => {
    expect(isReviewDue({}, now)).toBe(true);
  });
  it('never resurfaces permanent mastery', () => {
    const entry = { nextReviewAt: null, status: 'permanent' };
    expect(isReviewDue(entry, now)).toBe(false);
    expect(reviewState(entry, now)).toBe('permanent');
  });
});

describe('applyReviewResult — expanding intervals', () => {
  const now = new Date('2026-07-15T00:00:00.000Z');
  it('a passed review advances the stage and pushes the next review FURTHER out', () => {
    const entry = defaultReviewEntry(skill(), new Date('2026-07-01T00:00:00.000Z'));
    const after = applyReviewResult(entry, true, now);
    expect(after.status).toBe('fresh');
    expect(after.reviewStage).toBe(1);
    expect(Date.parse(after.nextReviewAt) - now.getTime()).toBe(REVIEW_INTERVALS_DAYS[1] * DAY);
    expect(after.reviewsPassed).toBe(1);
    expect(after.reviewsTaken).toBe(1);
  });
  it('three successful reviews make mastery permanent', () => {
    let entry = defaultReviewEntry(skill(), now);
    entry = applyReviewResult(entry, true, now); // stage 1
    entry = applyReviewResult(entry, true, now); // stage 2
    entry = applyReviewResult(entry, true, now); // permanent
    expect(entry.reviewsPassed).toBe(PERMANENT_MASTERY_PASSES);
    expect(entry.verificationPasses).toBe(PERMANENT_MASTERY_PASSES);
    expect(entry.reviewStage).toBe(REVIEW_INTERVALS_DAYS.length - 1);
    expect(entry.status).toBe('permanent');
    expect(entry.nextReviewAt).toBeNull();
    expect(entry.permanentAt).toBe(now.toISOString());
  });
  it('a failed review flips to needs-refresh and schedules a SOONER re-review, resetting the stage', () => {
    let entry = defaultReviewEntry(skill(), now);
    entry = applyReviewResult(entry, true, now); // stage 1
    const failed = applyReviewResult(entry, false, now);
    expect(failed.status).toBe('needs-refresh');
    expect(failed.reviewStage).toBe(0);
    expect(Date.parse(failed.nextReviewAt) - now.getTime()).toBe(REFRESH_INTERVAL_DAYS * DAY);
    expect(REFRESH_INTERVAL_DAYS).toBeLessThan(REVIEW_INTERVALS_DAYS[0]);
    expect(failed.reviewsPassed).toBe(1); // the earlier pass still counted
    expect(failed.reviewsTaken).toBe(2);
    expect(failed.verificationPasses).toBe(0);
  });
  it('never carries a floorLevel field — demotion is out of scope for the scheduler', () => {
    const entry = defaultReviewEntry(skill(), now);
    const failed = applyReviewResult(entry, false, now);
    expect(failed).not.toHaveProperty('floorLevel');
  });
  it('treats permanent mastery as terminal even when a stale review result arrives', () => {
    const permanent = { ...defaultReviewEntry(skill(), now), status: 'permanent', nextReviewAt: null };
    expect(applyReviewResult(permanent, true, now)).toBe(permanent);
    expect(applyReviewResult(permanent, false, now)).toBe(permanent);
  });
});

describe('applyPractice — active use resets staleness', () => {
  it('pushes nextReviewAt forward and clears needs-refresh, but never pulls it earlier', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const stale = { ...defaultReviewEntry(skill(), new Date('2026-07-01T00:00:00.000Z')), status: 'needs-refresh', reviewStage: 0, nextReviewAt: '2026-07-08T00:00:00.000Z' };
    const after = applyPractice(stale, now);
    expect(after.status).toBe('fresh');
    expect(Date.parse(after.nextReviewAt)).toBeGreaterThan(now.getTime());
    expect(after.lastPracticedAt).toBe(now.toISOString());
  });
  it('does not pull a far-future review earlier', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const future = { ...defaultReviewEntry(skill(), now), reviewStage: 2, nextReviewAt: new Date(now.getTime() + 90 * DAY).toISOString() };
    const after = applyPractice(future, now);
    expect(after.nextReviewAt).toBe(future.nextReviewAt);
  });
  it('does not restart the clock for permanent mastery', () => {
    const permanent = { ...defaultReviewEntry(skill()), status: 'permanent', nextReviewAt: null };
    expect(applyPractice(permanent, new Date('2026-08-01T00:00:00.000Z'))).toBe(permanent);
  });
});

describe('retentionForEntry — 90-day retention %', () => {
  const now = new Date('2026-07-15T00:00:00.000Z');
  it('is passed/taken over the window, null when no in-window reviews', () => {
    expect(retentionForEntry({ reviewHistory: [] }, now).retentionPct).toBeNull();
    const entry = { reviewHistory: [
      { date: new Date(now.getTime() - 10 * DAY).toISOString(), passed: true },
      { date: new Date(now.getTime() - 20 * DAY).toISOString(), passed: false },
      { date: new Date(now.getTime() - 5 * DAY).toISOString(), passed: true },
    ] };
    expect(retentionForEntry(entry, now)).toMatchObject({ reviewsTaken: 3, reviewsPassed: 2, retentionPct: 67 });
  });
  it('excludes reviews older than the window', () => {
    const entry = { reviewHistory: [
      { date: new Date(now.getTime() - 200 * DAY).toISOString(), passed: false },
      { date: new Date(now.getTime() - 1 * DAY).toISOString(), passed: true },
    ] };
    expect(retentionForEntry(entry, now)).toMatchObject({ reviewsTaken: 1, reviewsPassed: 1, retentionPct: 100 });
  });
});

describe('applySessionToReviewSchedule — session sync', () => {
  it('preserves overlapping mastery additions and reviews', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const first = skill();
    const second = skill({ skillId: 'multiplication:L1' });
    await applySessionToReviewSchedule({ masteredSkills: [first], now });

    const reviewResults = [{ skillId: first.skillId, passed: true }];
    await Promise.all([
      applySessionToReviewSchedule({ masteredSkills: [second], reviewResults, now }),
      applySessionToReviewSchedule({ reviewResults, now }),
    ]);

    expect(await getReviewSchedule()).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: first.skillId, reviewsTaken: 2 }),
      expect.objectContaining({ skillId: second.skillId, reviewsTaken: 0 }),
    ]));
  });

  it('upserts newly-mastered skills (fresh installs: nothing tracked until first mastery)', async () => {
    expect(await getDueReviews(new Date())).toEqual([]); // fresh install → nothing
    const res = await applySessionToReviewSchedule({ masteredSkills: [skill()], now: new Date('2026-07-01T00:00:00.000Z') });
    expect(res.added).toBe(1);
    expect(Object.keys(store.skills)).toEqual(['multiplication:L0']);
    // Not due yet (7d out) → still nothing surfaces.
    expect(await getDueReviews(new Date('2026-07-02T00:00:00.000Z'))).toEqual([]);
  });

  it('does not reset an existing entry\'s schedule on re-mastery, only refreshes metadata', async () => {
    await applySessionToReviewSchedule({ masteredSkills: [skill()], now: new Date('2026-07-01T00:00:00.000Z') });
    const firstNext = store.skills['multiplication:L0'].nextReviewAt;
    await applySessionToReviewSchedule({ masteredSkills: [skill({ label: 'Renamed' })], now: new Date('2026-07-05T00:00:00.000Z') });
    expect(store.skills['multiplication:L0'].nextReviewAt).toBe(firstNext); // schedule preserved
    expect(store.skills['multiplication:L0'].label).toBe('Renamed');       // metadata refreshed
  });

  it('records a failed review as needs-refresh and honors the shorter refresh delay before re-serving', async () => {
    await applySessionToReviewSchedule({ masteredSkills: [skill()], now: new Date('2026-07-01T00:00:00.000Z') });
    const res = await applySessionToReviewSchedule({ reviewResults: [{ skillId: 'multiplication:L0', passed: false }], now: new Date('2026-07-10T00:00:00.000Z') });
    expect(res.reviewed).toBe(1);
    expect(store.skills['multiplication:L0'].status).toBe('needs-refresh');
    // Rescheduled REFRESH_INTERVAL_DAYS out — NOT served again immediately even
    // though it's needs-refresh (the refresh delay must be honored).
    expect(await getDueReviews(new Date('2026-07-10T12:00:00.000Z'))).toEqual([]);
    // ...but it IS served once the (shorter) refresh interval elapses.
    const later = new Date(Date.parse('2026-07-10T00:00:00.000Z') + (REFRESH_INTERVAL_DAYS + 1) * DAY);
    expect((await getDueReviews(later)).map(d => d.skillId)).toEqual(['multiplication:L0']);
  });

  it('resets staleness for actively-practiced mastered skills', async () => {
    // Mastered long ago and now overdue.
    await applySessionToReviewSchedule({ masteredSkills: [skill()], now: new Date('2026-01-01T00:00:00.000Z') });
    expect((await getDueReviews(new Date('2026-07-01T00:00:00.000Z'))).length).toBe(1);
    await applySessionToReviewSchedule({ masteredSkills: [skill()], practicedSkillIds: ['multiplication:L0'], now: new Date('2026-07-01T00:00:00.000Z') });
    expect((await getDueReviews(new Date('2026-07-01T00:00:00.000Z'))).length).toBe(0); // no longer stale
  });
});

describe('getDueReviews — caps + ordering', () => {
  it('returns most-overdue first, capped at the limit', async () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    await applySessionToReviewSchedule({ masteredSkills: [
      skill({ skillId: 'a' }), skill({ skillId: 'b' }), skill({ skillId: 'c' }),
    ], now: base });
    // Force distinct overdue times.
    store.skills.a.nextReviewAt = '2026-03-01T00:00:00.000Z';
    store.skills.b.nextReviewAt = '2026-02-01T00:00:00.000Z';
    store.skills.c.nextReviewAt = '2026-04-01T00:00:00.000Z';
    const due = await getDueReviews(new Date('2026-07-01T00:00:00.000Z'), 2);
    expect(due.map(d => d.skillId)).toEqual(['b', 'a']); // oldest-due first, capped at 2
  });

  it('ignores legacy memory-chunk schedules now owned by the memory item', async () => {
    await applySessionToReviewSchedule({
      masteredSkills: [skill({ skillId: 'memory:item:chunk', kind: 'memory' })],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(await getDueReviews(new Date('2026-07-01T00:00:00.000Z'))).toEqual([]);
  });
});

describe('getRetentionReport', () => {
  it('reports per-skill state + an overall 90-day retention %', async () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    await applySessionToReviewSchedule({ masteredSkills: [skill()], now: new Date('2026-07-01T00:00:00.000Z') });
    store.skills['multiplication:L0'].reviewHistory = [
      { date: new Date(now.getTime() - 2 * DAY).toISOString(), passed: true },
      { date: new Date(now.getTime() - 3 * DAY).toISOString(), passed: false },
    ];
    const report = await getRetentionReport(now);
    expect(report.trackedCount).toBe(1);
    expect(report.retentionPct).toBe(50);
    // Mastered 2026-07-01 with a 7-day first interval → overdue by 2026-07-15.
    expect(report.skills[0]).toMatchObject({ skillId: 'multiplication:L0', state: 'due' });
  });

  it('is empty with null retention on a fresh install', async () => {
    const report = await getRetentionReport(new Date());
    expect(report).toMatchObject({ trackedCount: 0, dueCount: 0, retentionPct: null });
  });
});
