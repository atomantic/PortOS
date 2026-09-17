/**
 * The activity calendar is the one surface that turns raw agent history into
 * the dashboard heatmap and the Eidoverse activity district, so its contract is
 * the grid shape and the counting rules — not the arithmetic of any one helper.
 *
 * Both stores are stubbed at their module boundary: the archive index
 * (`cosAgentIndex.js`) and live state (`cosState.js`). Fixture dates are UTC,
 * matching the day key the archive buckets and the daily report already use, so
 * the expectations hold whatever timezone the runner is in.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  index: new Map(), // agentId → YYYY-MM-DD bucket
  agents: {},       // state.agents
}));

vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: vi.fn(async () => mock.index),
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => ({ agents: mock.agents })),
}));

const { getActivityCalendar } = await import('./cosActivityCalendar.js');

// YYYY-MM-DD for N days before today, in UTC — the day key every CoS
// agent-history store uses.
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const completedAgent = (id, date) => ({ id, status: 'completed', completedAt: `${date}T12:00:00.000Z` });

beforeEach(() => {
  mock.index = new Map();
  mock.agents = {};
});

describe('getActivityCalendar', () => {
  it('returns Sunday-aligned whole weeks with today marked and later days flagged future', async () => {
    const { weeks } = await getActivityCalendar(4);

    expect(weeks).toHaveLength(4);
    expect(weeks.every(week => week.length === 7)).toBe(true);
    expect(weeks[0][0].dayOfWeek).toBe(0);
    expect(weeks.flat().find(day => day.isToday).date).toBe(new Date().toISOString().slice(0, 10));
    expect(weeks.flat().filter(day => day.isToday)).toHaveLength(1);

    const todayIdx = weeks.flat().findIndex(day => day.isToday);
    const after = weeks.flat().slice(todayIdx + 1);
    expect(after.every(day => day.isFuture === true)).toBe(true);
    expect(weeks.flat().slice(0, todayIdx + 1).some(day => day.isFuture)).toBe(false);
  });

  it('counts archived runs from the index and live completed runs from state', async () => {
    const yesterday = daysAgo(1);
    mock.index.set('agent-archived-a', yesterday);
    mock.index.set('agent-archived-b', yesterday);
    mock.agents = { 'agent-live': completedAgent('agent-live', daysAgo(0)) };

    const { weeks, summary, maxTasks } = await getActivityCalendar(4);
    const byDate = Object.fromEntries(weeks.flat().map(day => [day.date, day.tasks]));

    expect(byDate[yesterday]).toBe(2);
    expect(byDate[daysAgo(0)]).toBe(1);
    expect(summary).toMatchObject({ activeDays: 2, totalTasks: 3, avgTasksPerActiveDay: 1.5 });
    expect(maxTasks).toBe(2);
  });

  it('counts a record caught mid-archive once, not twice', async () => {
    // archiveStaleAgents indexes the record before evicting it from state, so
    // a read landing between those two writes sees the same run in both stores.
    const yesterday = daysAgo(1);
    mock.index.set('agent-both', yesterday);
    mock.agents = { 'agent-both': completedAgent('agent-both', yesterday) };

    const { summary } = await getActivityCalendar(4);

    expect(summary.totalTasks).toBe(1);
  });

  it('ignores live runs that are still in flight', async () => {
    mock.agents = {
      'agent-running': { id: 'agent-running', status: 'running', completedAt: null },
      'agent-paused': { id: 'agent-paused', status: 'paused', completedAt: null },
    };

    const { summary } = await getActivityCalendar(4);

    expect(summary).toMatchObject({ activeDays: 0, totalTasks: 0, avgTasksPerActiveDay: 0 });
  });

  it('counts a live handoff, because the archive it shares a grid with cannot recognize one', async () => {
    // The index stores only id -> date, so applying isAgentHandoff to live
    // records alone would drop a provider swap from today's cell while counting
    // it in every older one. Volume is counted uniformly instead.
    const today = daysAgo(0);
    mock.agents = {
      'agent-real': completedAgent('agent-real', today),
      'agent-swap': { ...completedAgent('agent-swap', today), result: { success: false, resumed: true } },
    };

    const { summary } = await getActivityCalendar(4);

    expect(summary.totalTasks).toBe(2);
  });

  it('counts a failed run — the grid is volume, not outcome', async () => {
    mock.agents = {
      'agent-failed': { ...completedAgent('agent-failed', daysAgo(0)), result: { success: false } },
    };

    const { summary } = await getActivityCalendar(4);

    expect(summary.totalTasks).toBe(1);
  });

  it('drops history older than the requested window', async () => {
    mock.index.set('agent-old', daysAgo(200));
    mock.index.set('agent-recent', daysAgo(2));

    const { summary } = await getActivityCalendar(4);

    expect(summary.totalTasks).toBe(1);
  });

  it('reports an empty install as zeroes rather than omitting the grid', async () => {
    const { weeks, maxTasks, summary } = await getActivityCalendar(2);

    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks.flat().every(day => day.tasks === 0)).toBe(true);
    // maxTasks floors at 1 so the client's `tasks / maxTasks` intensity ratio
    // never divides by zero on a fresh install.
    expect(maxTasks).toBe(1);
    expect(summary).toMatchObject({ activeDays: 0, totalTasks: 0 });
  });
});
