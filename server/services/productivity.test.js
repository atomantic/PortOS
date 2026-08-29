/**
 * Direct tests for the productivity service's computation paths (issue #3448).
 *
 * Before this suite the module existed only as a `vi.mock()` target in
 * `routes/cosInsightRoutes.test.js` — referenced by a test, executed by none.
 * Here the real module runs: only the file-I/O boundary is redirected
 * (`PATHS.cos` → a temp dir) and the agent history source (`cosAgentLifecycle.js` / `cosAgentIndex.js`) is
 * stubbed, so activity aggregation and insight derivation are exercised for real.
 *
 * Dates are built from LOCAL components (`new Date(y, m, d, h)`) because the
 * service reads local getters (`getDateString`, `getHours`, `getDay`) — that
 * keeps every expected value stable regardless of the runner's timezone.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'productivity-test-'));
const COS_DIR = join(TEST_DATA_ROOT, 'cos');
const PRODUCTIVITY_FILE = join(COS_DIR, 'productivity.json');

// productivity.js anchors its store at PATHS.cos — re-rooted into the temp tree
// along with every other data/-rooted PATHS member by makePathsProxy.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const mock = vi.hoisted(() => ({ agents: [] }));

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgents: vi.fn(async () => mock.agents),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: new EventEmitter(),
  emitLog: vi.fn(),
}));

const productivity = await import('./productivity.js');
const { cosEvents } = await import('./cosEvents.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Wednesday 2026-03-18 12:00 local. Week of Mon 2026-03-16 (ISO 2026-W12);
// the containing Sunday-start week begins 2026-03-15.
const NOW = new Date(2026, 2, 18, 12, 0, 0);

/** Completed-agent fixture with a local-time completion stamp. */
const agentOn = (id, { month = 3, day, hour = 10, minute = 0, success = true, duration = 60000, status = 'completed', completedAt } = {}) => ({
  id,
  taskId: `task-${id}`,
  status,
  completedAt: completedAt === undefined
    ? new Date(2026, month - 1, day, hour, minute, 0).toISOString()
    : completedAt,
  result: { success, duration },
});

const seed = (data) => {
  mkdirSync(COS_DIR, { recursive: true });
  writeFileSync(PRODUCTIVITY_FILE, JSON.stringify(data));
};

const readStore = () => JSON.parse(readFileSync(PRODUCTIVITY_FILE, 'utf-8'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mock.agents = [];
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(COS_DIR, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // The mocked bus is shared across cases — drop listeners here so a failing
  // assertion can't strand one and have a later case observe it.
  cosEvents.removeAllListeners();
});

describe('recalculateProductivity — activity totals', () => {
  it('returns empty totals for an empty history', async () => {
    const result = await productivity.recalculateProductivity();
    expect(result).not.toHaveProperty('streaks');
    expect(result.totals).toEqual({
      totalTasks: 0,
      successfulTasks: 0,
      successRate: 0,
      activeDays: 0,
      activeWeeks: 0,
    });
  });

  it('counts distinct active days and weeks without deriving streaks', async () => {
    mock.agents = [
      agentOn('a', { day: 16 }),
      agentOn('b', { day: 17 }),
      agentOn('c', { day: 18 }),
    ];

    const result = await productivity.recalculateProductivity();

    expect(result).not.toHaveProperty('streaks');
    expect(result.totals).toMatchObject({ totalTasks: 3, activeDays: 3, activeWeeks: 1 });
  });

  it('ignores agents that are not completed or carry no completion stamp', async () => {
    mock.agents = [
      agentOn('good', { day: 18 }),
      { ...agentOn('running', { day: 18 }), status: 'running' },
      { ...agentOn('unstamped', { day: 18 }), completedAt: null },
    ];

    const result = await productivity.recalculateProductivity();

    expect(result.totals.totalTasks).toBe(1);
    expect(result.dailyHistory['2026-03-18'].tasks).toBe(1);
  });
});
describe('recalculateProductivity — aggregates and milestones', () => {
  it('computes exact hourly, day-of-week and per-date aggregates', async () => {
    mock.agents = [
      agentOn('a1', { day: 18, hour: 9, success: true, duration: 1000 }),
      agentOn('a2', { day: 18, hour: 9, success: true, duration: 2000 }),
      agentOn('a3', { day: 18, hour: 9, success: false, duration: 3000 }),
    ];

    const result = await productivity.recalculateProductivity();

    expect(result.hourlyPatterns[9]).toEqual({
      tasks: 3,
      successes: 2,
      failures: 1,
      totalDuration: 6000,
      avgDuration: 2000,
      successRate: 67,
    });
    // 2026-03-18 is a Wednesday → day-of-week index 3.
    expect(result.dailyPatterns[3]).toMatchObject({ tasks: 3, successes: 2, failures: 1, avgDuration: 2000 });
    expect(result.dailyHistory['2026-03-18']).toEqual({
      tasks: 3,
      successes: 2,
      failures: 1,
      successRate: 67,
    });
    expect(result.totals).toMatchObject({ totalTasks: 3, successfulTasks: 2, successRate: 67 });
  });

  it('awards task-count milestones without streak milestones', async () => {
    mock.agents = [
      ...Array.from({ length: 4 }, (_, i) => agentOn(`d16-${i}`, { day: 16 })),
      ...Array.from({ length: 3 }, (_, i) => agentOn(`d17-${i}`, { day: 17 })),
      ...Array.from({ length: 3 }, (_, i) => agentOn(`d18-${i}`, { day: 18 })),
    ];

    const { milestones } = await productivity.recalculateProductivity();

    expect(milestones).toContainEqual({
      type: 'tasks',
      value: 10,
      achievedAt: expect.any(String),
      description: 'Completed 10 tasks',
    });
    expect(milestones.some(m => m.type === 'streak')).toBe(false);
    // The 25-task milestone is not reached yet.
    expect(milestones.filter(m => m.value === 25)).toEqual([]);
  });

  it('persists the recalculated snapshot with a lastUpdated stamp', async () => {
    mock.agents = [agentOn('a1', { day: 18 })];

    await productivity.recalculateProductivity();

    const stored = readStore();
    expect(stored).not.toHaveProperty('streaks');
    expect(stored.lastUpdated).toBe(NOW.toISOString());
  });
});

describe('onTaskCompleted — incremental productivity updates', () => {
  it('records the completed task, drops a retired streak field, and emits the update event', async () => {
    seed({
      streaks: { currentDaily: 9, longestDaily: 12 },
      hourlyPatterns: {}, dailyPatterns: {}, dailyHistory: {}, milestones: [],
    });
    const emitted = [];
    const listener = () => emitted.push('productivity:updated');
    cosEvents.on('productivity:updated', listener);

    await productivity.onTaskCompleted(agentOn('a1', { day: 18, hour: 9, duration: 4000 }));

    const stored = readStore();
    expect(stored).not.toHaveProperty('streaks');
    expect(stored.dailyHistory['2026-03-18']).toMatchObject({ tasks: 1, successes: 1, failures: 0 });
    expect(stored.hourlyPatterns[9]).toMatchObject({ tasks: 1, successes: 1, avgDuration: 4000 });
    expect(emitted).toEqual(['productivity:updated']);
    cosEvents.off('productivity:updated', listener);
  });

  it('prunes daily history older than 90 days', async () => {
    seed({
      hourlyPatterns: {}, dailyPatterns: {},
      dailyHistory: {
        '2025-01-01': { tasks: 1, successes: 1, failures: 0, successRate: 100 },
        '2026-03-18': { tasks: 1, successes: 1, failures: 0, successRate: 100 },
      },
      milestones: [],
    });

    await productivity.onTaskCompleted(agentOn('a1', { day: 18 }));

    const stored = readStore();
    expect(stored.dailyHistory['2025-01-01']).toBeUndefined();
    expect(stored.dailyHistory['2026-03-18'].tasks).toBe(2);
  });

  it('is a no-op for an agent with no completion stamp', async () => {
    await productivity.onTaskCompleted({ id: 'a1', result: { success: true } });
    expect(existsSync(PRODUCTIVITY_FILE)).toBe(false);
  });

  it('does not leak one incremental update into the next empty-store read', async () => {
    await productivity.onTaskCompleted(agentOn('a1', { day: 18 }));
    rmSync(PRODUCTIVITY_FILE);

    const fresh = await productivity.loadProductivity();

    expect(fresh.dailyHistory).toEqual({});
    expect(fresh.hourlyPatterns).toEqual({});
  });
});
describe('getProductivityInsights', () => {
  const insightsFixture = {
    hourlyPatterns: {
      9: { tasks: 10, successes: 8, failures: 2, totalDuration: 10000, avgDuration: 1000, successRate: 80 },
      13: { tasks: 6, successes: 3, failures: 3, totalDuration: 6000, avgDuration: 1000, successRate: 50 },
      // Below the 5-task reliability floor — must be filtered out entirely.
      2: { tasks: 4, successes: 4, failures: 0, totalDuration: 4000, avgDuration: 1000, successRate: 100 },
    },
    dailyPatterns: {
      3: { tasks: 8, successes: 7, failures: 1, totalDuration: 8000, avgDuration: 1000, successRate: 88 },
      5: { tasks: 4, successes: 1, failures: 3, totalDuration: 4000, avgDuration: 1000, successRate: 25 },
      // Below the 3-task floor for days.
      0: { tasks: 2, successes: 2, failures: 0, totalDuration: 2000, avgDuration: 1000, successRate: 100 },
    },
    dailyHistory: {},
    milestones: [],
  };

  it('derives peak-hour and best-day insights with concrete copy', async () => {
    seed(insightsFixture);

    const result = await productivity.getProductivityInsights();

    expect(result.bestHour).toMatchObject({ hour: 9, successRate: 80 });
    expect(result.worstHour).toMatchObject({ hour: 13, successRate: 50 });
    expect(result.bestDay).toMatchObject({ day: 3, dayName: 'Wednesday', successRate: 88 });
    expect(result.worstDay).toMatchObject({ day: 5, dayName: 'Friday', successRate: 25 });

    expect(result.insights).toEqual([
      {
        type: 'optimization',
        title: 'Peak Performance Hour',
        message: 'Tasks completed around 9AM have a 80% success rate',
        icon: 'clock',
      },
      {
        type: 'info',
        title: 'Most Productive Day',
        message: 'Wednesdays show 88% success rate with 8 tasks completed',
        icon: 'calendar',
      },
    ]);
  });

  it('labels midnight and afternoon peak hours in 12-hour form', async () => {
    seed({
      ...insightsFixture,
      hourlyPatterns: { 0: { tasks: 5, successes: 5, failures: 0, avgDuration: 100, successRate: 100 } },
    });
    expect((await productivity.getProductivityInsights()).insights[0].message)
      .toBe('Tasks completed around 12AM have a 100% success rate');

    seed({
      ...insightsFixture,
      hourlyPatterns: { 15: { tasks: 5, successes: 3, failures: 2, avgDuration: 100, successRate: 60 } },
    });
    expect((await productivity.getProductivityInsights()).insights[0].message)
      .toBe('Tasks completed around 3PM have a 60% success rate');
  });

  it('returns no insights and null extremes for a store with no history', async () => {
    const result = await productivity.getProductivityInsights();

    expect(result.insights).toEqual([]);
    expect(result.bestHour).toBeNull();
    expect(result.worstHour).toBeNull();
    expect(result.bestDay).toBeNull();
    expect(result.worstDay).toBeNull();
  });
});

describe('getProductivitySummary', () => {
  it('projects the dashboard fields from the stored snapshot', async () => {
    seed({
      streaks: { currentDaily: 3, longestDaily: 9 },
      hourlyPatterns: {}, dailyPatterns: {}, dailyHistory: {},
      totals: { totalTasks: 20, successfulTasks: 18, successRate: 90, activeDays: 11, activeWeeks: 3 },
      milestones: [
        { type: 'streak', value: 30, description: '30-day work streak' },
        { type: 'tasks', value: 10, description: 'Completed 10 tasks' },
        { type: 'tasks', value: 25, description: 'Completed 25 tasks' },
      ],
    });

    expect(await productivity.getProductivitySummary()).toEqual({
      totalDays: 11,
      recentMilestone: { type: 'tasks', value: 25, description: 'Completed 25 tasks' },
    });
  });

  it('falls back to zeros and nulls for an empty store', async () => {
    expect(await productivity.getProductivitySummary()).toEqual({
      totalDays: 0,
      recentMilestone: null,
    });
  });
});

describe('getVelocityMetrics', () => {
  it('scores today against the historical active-day average', async () => {
    seed({
      streaks: {}, hourlyPatterns: {}, dailyPatterns: {}, milestones: [],
      dailyHistory: {
        '2026-03-18': { tasks: 6, successes: 5, failures: 1, successRate: 83 },
        '2026-03-17': { tasks: 4, successes: 4, failures: 0, successRate: 100 },
        '2026-03-16': { tasks: 2, successes: 1, failures: 1, successRate: 50 },
        // Zero-task days are excluded from the average.
        '2026-03-15': { tasks: 0, successes: 0, failures: 0, successRate: 0 },
      },
    });

    expect(await productivity.getVelocityMetrics()).toEqual({
      today: 6,
      todaySuccesses: 5,
      todayFailures: 1,
      avgPerDay: 3,
      historicalDays: 2,
      velocity: 200,
      velocityLabel: 'exceptional',
    });
  });

  it('labels the first ever active day', async () => {
    seed({
      streaks: {}, hourlyPatterns: {}, dailyPatterns: {}, milestones: [],
      dailyHistory: { '2026-03-18': { tasks: 2, successes: 2, failures: 0, successRate: 100 } },
    });

    expect(await productivity.getVelocityMetrics()).toMatchObject({ velocity: 100, velocityLabel: 'first-day' });
  });

  it('leaves velocity null when nothing has been completed today', async () => {
    seed({
      streaks: {}, hourlyPatterns: {}, dailyPatterns: {}, milestones: [],
      dailyHistory: { '2026-03-17': { tasks: 4, successes: 4, failures: 0, successRate: 100 } },
    });

    expect(await productivity.getVelocityMetrics()).toMatchObject({
      today: 0,
      avgPerDay: 4,
      historicalDays: 1,
      velocity: null,
      velocityLabel: null,
    });
  });
});

describe('getOptimalTimeInfo', () => {
  it('needs at least three reliable hours before making a recommendation', async () => {
    seed({
      streaks: {}, dailyPatterns: {}, dailyHistory: {}, milestones: [],
      hourlyPatterns: {
        9: { tasks: 5, successes: 5, failures: 0, successRate: 100 },
        10: { tasks: 4, successes: 2, failures: 2, successRate: 50 },
        11: { tasks: 2, successes: 2, failures: 0, successRate: 100 },
      },
    });

    expect(await productivity.getOptimalTimeInfo()).toEqual({ hasData: false });
  });

  it('ranks the top quartile and points at the next optimal hour', async () => {
    seed({
      streaks: {}, dailyPatterns: {}, dailyHistory: {}, milestones: [],
      hourlyPatterns: {
        9: { tasks: 6, successes: 6, failures: 0, successRate: 100 },
        10: { tasks: 5, successes: 4, failures: 1, successRate: 80 },
        14: { tasks: 5, successes: 3, failures: 2, successRate: 60 },
        20: { tasks: 5, successes: 1, failures: 4, successRate: 20 },
      },
    });

    // Fake clock sits at 12:00, an hour with no recorded history.
    expect(await productivity.getOptimalTimeInfo()).toEqual({
      hasData: true,
      currentHour: 12,
      currentSuccessRate: null,
      currentTasks: 0,
      isOptimal: false,
      isAboveAverage: false,
      topHours: [9],
      nextOptimalHour: 9,
      nextOptimalFormatted: '9AM',
      avgSuccessRate: 65,
      peakSuccessRate: 100,
    });
  });

  it('marks the current hour optimal when it tops the ranking', async () => {
    seed({
      streaks: {}, dailyPatterns: {}, dailyHistory: {}, milestones: [],
      hourlyPatterns: {
        12: { tasks: 8, successes: 8, failures: 0, successRate: 100 },
        10: { tasks: 5, successes: 4, failures: 1, successRate: 80 },
        14: { tasks: 5, successes: 3, failures: 2, successRate: 60 },
      },
    });

    expect(await productivity.getOptimalTimeInfo()).toMatchObject({
      isOptimal: true,
      isAboveAverage: true,
      currentSuccessRate: 100,
      currentTasks: 8,
      nextOptimalHour: null,
      nextOptimalFormatted: null,
      avgSuccessRate: 80,
    });
  });
});

describe('getDailyTrends', () => {
  it('fills missing days with zeros and reports rolling averages over the window', async () => {
    seed({
      streaks: {}, hourlyPatterns: {}, dailyPatterns: {}, milestones: [],
      dailyHistory: {
        '2026-03-18': { tasks: 4, successes: 4, failures: 0, successRate: 100 },
        '2026-03-16': { tasks: 2, successes: 1, failures: 1, successRate: 50 },
      },
    });

    const { data, summary } = await productivity.getDailyTrends(7);

    expect(data).toHaveLength(7);
    expect(data[0].date).toBe('2026-03-12');
    expect(data[6]).toMatchObject({ date: '2026-03-18', dateShort: '03-18', tasks: 4, rollingAvgTasks: 0.9 });
    expect(data[3]).toMatchObject({ date: '2026-03-15', tasks: 0, successRate: 0 });
    expect(summary).toMatchObject({
      days: 7,
      activeDays: 2,
      totalTasks: 6,
      avgTasksPerActiveDay: 3,
      avgSuccessRate: 75,
    });
  });

  it('calls out a falling volume trend against the prior week', async () => {
    const dailyHistory = {};
    // Older week (2026-03-05 … 2026-03-11): 5 tasks a day. Recent week: 1 a day.
    for (let day = 5; day <= 11; day++) {
      dailyHistory[`2026-03-${String(day).padStart(2, '0')}`] = { tasks: 5, successes: 5, failures: 0, successRate: 100 };
    }
    for (let day = 12; day <= 18; day++) {
      dailyHistory[`2026-03-${String(day).padStart(2, '0')}`] = { tasks: 1, successes: 0, failures: 1, successRate: 0 };
    }
    seed({ hourlyPatterns: {}, dailyPatterns: {}, milestones: [], dailyHistory });

    const { summary } = await productivity.getDailyTrends(30);

    expect(summary.volumeTrend).toBe('decreasing');
    expect(summary.successTrend).toBe('declining');
  });
});

describe('getActivityCalendar', () => {
  it('builds Sunday-aligned weeks through the end of the current week', async () => {
    seed({
      hourlyPatterns: {}, dailyPatterns: {}, milestones: [],
      dailyHistory: {
        '2026-03-18': { tasks: 7, successes: 6, failures: 1, successRate: 86 },
        '2026-03-10': { tasks: 3, successes: 3, failures: 0, successRate: 100 },
      },
    });

    const calendar = await productivity.getActivityCalendar(2);

    // 2026-03-01 (Sunday) through 2026-03-21 (Saturday) → three full weeks.
    expect(calendar.weeks).toHaveLength(3);
    expect(calendar.weeks.every(week => week.length === 7)).toBe(true);
    expect(calendar.weeks[0][0].date).toBe('2026-03-01');
    expect(calendar.weeks[2][6]).toMatchObject({ date: '2026-03-21', isFuture: true, tasks: 0 });

    const today = calendar.weeks.flat().find(d => d.isToday);
    expect(today).toMatchObject({ date: '2026-03-18', tasks: 7, successRate: 86 });

    expect(calendar.maxTasks).toBe(7);
    expect(calendar).not.toHaveProperty('currentStreak');
    expect(calendar.summary).toEqual({
      totalDays: 21,
      activeDays: 2,
      totalTasks: 10,
      totalSuccesses: 9,
      successRate: 90,
      avgTasksPerActiveDay: 5,
    });
  });
});
