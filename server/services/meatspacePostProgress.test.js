import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route file reads by path so getPostProgress sees sessions, the training log,
// and memory items independently (all share the same mocked fileUtils).
const state = { sessions: [], training: [], memoryItems: [] };

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/tmp/test-data', meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn((path, defaultValue) => {
    if (typeof path === 'string') {
      if (path.includes('post-sessions')) return Promise.resolve({ sessions: state.sessions });
      if (path.includes('post-training-log')) return Promise.resolve({ entries: state.training });
      if (path.includes('memory-items')) return Promise.resolve({ items: state.memoryItems });
    }
    return Promise.resolve(defaultValue);
  }),
}));

// getUserTimezone (via ../lib/timezone.js) reads getSettings() for the local-day
// boundary (issue #2681). Mock it to no configured tz so getUserTimezone falls
// back to the process timezone (TZ=UTC in tests) — matching these tests' UTC-today
// assumptions.
vi.mock('../services/settings.js', () => ({
  getSettings: () => Promise.resolve({}),
}));

import { getPostProgress, getPostStats, getUnifiedActivityStreak } from './meatspacePost.js';
import { getTrainingStats } from './meatspacePostTraining.js';
import { postProgressQuerySchema } from '../lib/postValidation.js';

const mathTask = (score, questions) => ({ module: 'mental-math', type: 'multiplication', score, questions });
const q = (correct, responseMs = 2000) => ({ prompt: '2 x 3', answered: correct ? 6 : 1, correct, responseMs });

function todayStr() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().split('T')[0]; }

beforeEach(() => {
  state.sessions = [];
  state.training = [];
  state.memoryItems = [];
});

describe('getPostProgress bucketing', () => {
  it('aggregates same-day sessions into one byDay bucket', async () => {
    const d = todayStr();
    state.sessions = [
      { date: d, durationMs: 60000, score: 80, tasks: [mathTask(80, [q(true), q(true), q(false)])] },
      { date: d, durationMs: 120000, score: 60, tasks: [mathTask(60, [q(true), q(false)])] },
    ];
    const p = await getPostProgress({ days: 90 });
    // Two sessions on one day collapse to a single point (no x-axis collision).
    expect(p.series.byDay).toHaveLength(1);
    const bucket = p.series.byDay[0];
    expect(bucket.date).toBe(d);
    expect(bucket.sessions).toBe(2);
    expect(bucket.score).toBe(70); // (80 + 60) / 2
    expect(bucket.minutes).toBe(3); // (1 + 2) minutes
    expect(bucket.accuracy).toBeGreaterThan(0);
  });

  it('respects the window cutoff', async () => {
    state.sessions = [
      { date: daysAgo(100), durationMs: 60000, score: 50, tasks: [mathTask(50, [q(true)])] },
      { date: daysAgo(2), durationMs: 60000, score: 90, tasks: [mathTask(90, [q(true)])] },
    ];
    const p = await getPostProgress({ days: 30 });
    expect(p.series.byDay).toHaveLength(1);
    expect(p.series.byDay[0].date).toBe(daysAgo(2));
    expect(p.totals.sessions).toBe(1);
  });

  it('returns an empty-but-shaped result for an empty window', async () => {
    const p = await getPostProgress({ days: 30 });
    expect(p.series.byDay).toEqual([]);
    expect(p.series.byDomain).toEqual({});
    expect(p.series.byDrill).toEqual({});
    expect(p.totals).toEqual({ minutesTrained: 0, sessions: 0, practiceEntries: 0 });
    expect(p.streak).toEqual({ current: 0, longest: 0, lastActiveDate: null });
  });

  it('counts practice-only days toward minutes and the unified streak', async () => {
    const d = todayStr();
    state.training = [
      { date: d, module: 'morse', drillType: 'morse-copy', questionCount: 5, correctCount: 4, totalMs: 90000 },
    ];
    const p = await getPostProgress({ days: 30 });
    expect(p.totals.practiceEntries).toBe(1);
    expect(p.totals.minutesTrained).toBe(2); // 90s ≈ 2 min (rounded)
    // A practice-only day (no scored session) still extends the streak.
    expect(p.streak.current).toBe(1);
    const day = p.series.byDay.find(b => b.date === d);
    expect(day.sessions).toBe(0);
    expect(day.score).toBeNull();
    expect(day.minutes).toBe(2);
  });

  it('builds per-domain and per-drill series keyed correctly', async () => {
    const d = todayStr();
    state.sessions = [
      { date: d, durationMs: 60000, score: 80, tasks: [mathTask(80, [q(true), q(true)])] },
    ];
    const p = await getPostProgress({ days: 90 });
    expect(p.series.byDomain['mental-math']).toBeDefined();
    expect(p.series.byDrill['multiplication']).toBeDefined();
    expect(p.series.byDrill['multiplication'][0].date).toBe(d);
  });

  it('includes a mastery block with the multiplication ladder and memory items', async () => {
    state.memoryItems = [
      { id: 'm1', title: 'Elements', mastery: { overallPct: 42 }, schedule: { nextReview: '2000-01-01T00:00:00.000Z' } },
    ];
    const p = await getPostProgress({ days: 90 });
    expect(p.mastery.multiplication).toHaveProperty('level');
    expect(p.mastery.multiplication).toHaveProperty('floorLevel');
    // The memory service prepends a built-in item, so find ours by id.
    const mine = p.mastery.memoryItems.find(i => i.id === 'm1');
    expect(mine).toMatchObject({ id: 'm1', title: 'Elements', overallPct: 42 });
    // Past-due nextReview → dueCount 1.
    expect(mine.dueCount).toBe(1);
  });
});

describe('unified streak agrees across every POST surface', () => {
  it('getPostStats, getTrainingStats, and getPostProgress report the SAME streak', async () => {
    // Interleave scored sessions and practice on distinct days: neither source
    // alone is a full streak, but together they form a consecutive run ending
    // today — every surface must see the same unified number.
    state.sessions = [
      { date: daysAgo(2), durationMs: 60000, score: 80, tasks: [mathTask(80, [q(true)])] },
      { date: todayStr(), durationMs: 60000, score: 90, tasks: [mathTask(90, [q(true)])] },
    ];
    state.training = [
      { date: daysAgo(1), module: 'morse', drillType: 'morse-copy', questionCount: 5, correctCount: 5, totalMs: 1000 },
    ];

    const [stats, training, progress, unified] = await Promise.all([
      getPostStats(30),
      getTrainingStats(30),
      getPostProgress({ days: 30 }),
      getUnifiedActivityStreak(),
    ]);

    // 3 consecutive active days (session, practice, session) → streak 3.
    expect(unified.current).toBe(3);
    expect(stats.currentStreak).toBe(3);
    expect(training.currentStreak).toBe(3);
    expect(progress.streak.current).toBe(3);
    // Longest agrees too.
    expect(stats.longestStreak).toBe(training.longestStreak);
    expect(stats.longestStreak).toBe(progress.streak.longest);
  });

  it('a practice-only day still extends the launcher (getPostStats) streak', async () => {
    // No scored sessions at all — the launcher/dashboard streak (getPostStats)
    // must still count Morse practice, matching the Morse trainer.
    state.training = [
      { date: daysAgo(1), module: 'morse', drillType: 'morse-copy', questionCount: 5, correctCount: 5, totalMs: 1000 },
      { date: todayStr(), module: 'morse', drillType: 'morse-copy', questionCount: 5, correctCount: 5, totalMs: 1000 },
    ];
    const stats = await getPostStats(30);
    expect(stats.currentStreak).toBe(2);
    // But completedToday stays SCORED-session specific — no scored POST today.
    expect(stats.completedToday).toBe(false);
  });
});

describe('postProgressQuerySchema clamping', () => {
  it('defaults days to 90 when missing or NaN', () => {
    expect(postProgressQuerySchema.parse({}).days).toBe(90);
    expect(postProgressQuerySchema.parse({ days: 'abc' }).days).toBe(90);
    expect(postProgressQuerySchema.parse({ days: '' }).days).toBe(90);
  });

  it('clamps days above 365', () => {
    expect(postProgressQuerySchema.parse({ days: '1000' }).days).toBe(365);
  });

  it('treats <=0 as all-time (0)', () => {
    expect(postProgressQuerySchema.parse({ days: '0' }).days).toBe(0);
    expect(postProgressQuerySchema.parse({ days: '-5' }).days).toBe(0);
  });

  it('passes through a valid in-range value and defaults bucket to day', () => {
    const parsed = postProgressQuerySchema.parse({ days: '30' });
    expect(parsed.days).toBe(30);
    expect(parsed.bucket).toBe('day');
  });
});
