import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mock = vi.hoisted(() => ({
  state: null,
  daemonRunning: true,
  // agentsByDate: { 'YYYY-MM-DD': [agent, ...] }
  agentsByDate: {}
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.state),
  ensureDirectories: vi.fn(async () => {}),
  REPORTS_DIR: '/tmp/reports',
  isDaemonRunning: () => mock.daemonRunning
}));

// The date-bucket index is derived from the same fixture as the on-disk buckets,
// mirroring the real invariant: every archived agent has an index entry.
vi.mock('./cosAgentIndex.js', () => ({
  getAgentsByDate: vi.fn(async (date) => mock.agentsByDate[date] || []),
  getAgentIdsForDates: vi.fn(async (dates) => new Map(
    dates.map(date => [date, (mock.agentsByDate[date] || []).map(a => a.id)])
  ))
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  atomicWrite: vi.fn(async () => {})
}));

import { getAgentsByDate } from './cosAgentIndex.js';
import { atomicWrite } from '../lib/fileUtils.js';
import { generateReport, getTodayActivity, getWhileAwayActivity } from './cosReports.js';

// Build a completed agent record at a fixed completedAt offset (ms before now).
const agentAt = (id, { msAgo, success = true, desc = 'did a thing', taskType = 'review', app = null } = {}) => {
  const completedAt = new Date(Date.now() - msAgo).toISOString();
  const startedAt = new Date(Date.now() - msAgo - 60000).toISOString();
  return {
    id,
    taskId: `task-${id}`,
    status: 'completed',
    startedAt,
    completedAt,
    result: { success, duration: 60000 },
    metadata: { taskDescription: desc, taskType, app }
  };
};

const stateWith = (agentList) => ({
  agents: Object.fromEntries(agentList.map(a => [a.id, a])),
  stats: {},
  paused: false
});

describe('getWhileAwayActivity', () => {
  beforeEach(() => {
    mock.daemonRunning = true;
    mock.agentsByDate = {};
    mock.state = stateWith([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('returns only completed agents within the since-window', async () => {
    const recent = agentAt('a1', { msAgo: 60 * 60000 });   // 1h ago — in window
    const old = agentAt('a2', { msAgo: 5 * 3600000 });     // 5h ago — out of window
    mock.state = stateWith([recent, old]);

    const since = new Date(Date.now() - 2 * 3600000).toISOString(); // 2h ago
    const result = await getWhileAwayActivity(since);

    expect(result.stats.completed).toBe(1);
    expect(result.accomplishments).toHaveLength(1);
    expect(result.accomplishments[0].id).toBe('a1');
  });

  it('splits successes into accomplishments and failures into incidents', async () => {
    mock.state = stateWith([
      agentAt('ok1', { msAgo: 10 * 60000, success: true }),
      agentAt('ok2', { msAgo: 20 * 60000, success: true }),
      agentAt('bad1', { msAgo: 30 * 60000, success: false })
    ]);

    const since = new Date(Date.now() - 3600000).toISOString();
    const result = await getWhileAwayActivity(since);

    expect(result.stats).toMatchObject({ completed: 3, succeeded: 2, failed: 1, successRate: 67 });
    expect(result.accomplishments.map(a => a.id)).toEqual(['ok1', 'ok2']); // most-recent first
    expect(result.incidents.map(a => a.id)).toEqual(['bad1']);
  });

  it('merges archived agents from date buckets the window spans', async () => {
    const liveAgent = agentAt('live', { msAgo: 30 * 60000 });
    mock.state = stateWith([liveAgent]);
    // An archived agent that completed ~1h ago lives in today's bucket.
    const todayStr = new Date().toISOString().slice(0, 10);
    mock.agentsByDate[todayStr] = [agentAt('archived', { msAgo: 50 * 60000 })];

    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    const result = await getWhileAwayActivity(since);

    const ids = result.accomplishments.map(a => a.id).sort();
    expect(ids).toEqual(['archived', 'live']);
    expect(result.stats.completed).toBe(2);
  });

  it('prefers the live copy over an archived duplicate of the same id', async () => {
    const live = agentAt('dup', { msAgo: 30 * 60000, success: true, desc: 'live version' });
    mock.state = stateWith([live]);
    const todayStr = new Date().toISOString().slice(0, 10);
    mock.agentsByDate[todayStr] = [agentAt('dup', { msAgo: 30 * 60000, success: false, desc: 'stale archived version' })];

    const since = new Date(Date.now() - 3600000).toISOString();
    const result = await getWhileAwayActivity(since);

    expect(result.stats.completed).toBe(1);
    expect(result.accomplishments).toHaveLength(1);
    expect(result.accomplishments[0].description).toBe('live version');
    expect(result.incidents).toHaveLength(0);
  });

  it('falls back to a 24h window when since is absent or garbage', async () => {
    const within = agentAt('w', { msAgo: 12 * 3600000 });   // 12h ago — inside 24h
    const beyond = agentAt('b', { msAgo: 40 * 3600000 });   // 40h ago — outside 24h
    mock.state = stateWith([within, beyond]);

    for (const bad of [undefined, '', 'not-a-date', 'null']) {
      const result = await getWhileAwayActivity(bad);
      expect(result.stats.completed).toBe(1);
      expect(result.accomplishments[0].id).toBe('w');
    }
  });

  it('treats a future since marker as the 24h fallback (clock skew guard)', async () => {
    const within = agentAt('w', { msAgo: 6 * 3600000 });
    mock.state = stateWith([within]);

    const future = new Date(Date.now() + 3600000).toISOString();
    const result = await getWhileAwayActivity(future);

    expect(result.stats.completed).toBe(1);
    expect(result.accomplishments[0].id).toBe('w');
  });

  it('reports daemon running/paused state', async () => {
    mock.daemonRunning = false;
    mock.state = { agents: {}, stats: {}, paused: true };

    const result = await getWhileAwayActivity(new Date(Date.now() - 3600000).toISOString());

    expect(result.isRunning).toBe(false);
    expect(result.isPaused).toBe(true);
    expect(result.stats.completed).toBe(0);
    expect(result.accomplishments).toEqual([]);
    expect(result.incidents).toEqual([]);
  });

  it('caps accomplishments and incidents at 8 each', async () => {
    const many = [];
    for (let i = 0; i < 12; i++) many.push(agentAt(`ok${i}`, { msAgo: (i + 1) * 60000, success: true }));
    for (let i = 0; i < 12; i++) many.push(agentAt(`bad${i}`, { msAgo: (i + 1) * 60000, success: false }));
    mock.state = stateWith(many);

    const since = new Date(Date.now() - 3600000).toISOString();
    const result = await getWhileAwayActivity(since);

    expect(result.accomplishments).toHaveLength(8);
    expect(result.incidents).toHaveLength(8);
    expect(result.stats.completed).toBe(24);
  });

  it('skips the archive read entirely when every indexed id is still live (#3501)', async () => {
    const live = agentAt('a1', { msAgo: 30 * 60000 });
    mock.state = stateWith([live]);
    const todayStr = new Date().toISOString().slice(0, 10);
    mock.agentsByDate[todayStr] = [live]; // archived at completion, still in state

    const result = await getWhileAwayActivity(new Date(Date.now() - 3600000).toISOString());

    expect(result.stats.completed).toBe(1);
    expect(getAgentsByDate).not.toHaveBeenCalled();
  });
});

// Completed agent pinned to an explicit UTC date so the assertions can't drift
// across a midnight boundary mid-run.
const agentOnDate = (id, dateStr, { success = true, desc = 'did a thing' } = {}) => ({
  id,
  taskId: `task-${id}`,
  status: 'completed',
  startedAt: `${dateStr}T11:00:00.000Z`,
  completedAt: `${dateStr}T12:00:00.000Z`,
  result: { success, duration: 3600000 },
  metadata: { taskDescription: desc, taskType: 'review' }
});

const todayStr = () => new Date().toISOString().slice(0, 10);

describe('generateReport (#3501 date-bucket sourcing)', () => {
  beforeEach(() => {
    mock.daemonRunning = true;
    mock.agentsByDate = {};
    mock.state = stateWith([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('reports a historical date from the archive after state.json was swept', async () => {
    // archiveStaleAgents evicted these from state.json — before #3501 the report
    // scanned state.agents only and came back all-zero.
    mock.agentsByDate['2026-01-15'] = [
      agentOnDate('old1', '2026-01-15', { success: true }),
      agentOnDate('old2', '2026-01-15', { success: false })
    ];

    const report = await generateReport('2026-01-15');

    expect(report.date).toBe('2026-01-15');
    expect(report.summary).toMatchObject({ tasksCompleted: 1, tasksFailed: 1, totalAgents: 2 });
    expect(report.agents.map(a => a.id).sort()).toEqual(['old1', 'old2']);
    expect(report.agents[0].duration).toBe(3600000);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('prefers the live record over its archived copy', async () => {
    const date = '2026-01-16';
    // Live record carries the authoritative verdict; the archive predates it.
    mock.state = stateWith([agentOnDate('dup', date, { success: true })]);
    mock.agentsByDate[date] = [agentOnDate('dup', date, { success: false })];

    const report = await generateReport(date);

    expect(report.summary).toMatchObject({ tasksCompleted: 1, tasksFailed: 0, totalAgents: 1 });
    expect(getAgentsByDate).not.toHaveBeenCalled();
  });

  it('ignores agents completed on other dates', async () => {
    mock.state = stateWith([agentOnDate('other', '2026-01-17')]);
    mock.agentsByDate['2026-01-18'] = [agentOnDate('wanted', '2026-01-18')];

    const report = await generateReport('2026-01-18');

    expect(report.agents.map(a => a.id)).toEqual(['wanted']);
  });
});

describe('getTodayActivity (#3501 date-bucket sourcing)', () => {
  beforeEach(() => {
    mock.daemonRunning = true;
    mock.agentsByDate = {};
    mock.state = stateWith([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('counts today agents that have been archived out of state.json', async () => {
    const today = todayStr();
    mock.state = stateWith([agentOnDate('live', today, { success: true })]);
    mock.agentsByDate[today] = [
      agentOnDate('live', today, { success: true }),
      agentOnDate('evicted', today, { success: false })
    ];

    const activity = await getTodayActivity();

    expect(activity.stats).toMatchObject({ completed: 2, succeeded: 1, failed: 1, successRate: 50 });
    expect(activity.time.totalDurationMs).toBe(7200000);
    expect(activity.accomplishments.map(a => a.id)).toEqual(['live']);
  });

  it('still counts running agents from live state', async () => {
    const today = todayStr();
    mock.state = stateWith([
      agentOnDate('done', today),
      { id: 'busy', taskId: 'task-busy', status: 'running', startedAt: new Date().toISOString() }
    ]);
    mock.agentsByDate[today] = [agentOnDate('done', today)];

    const activity = await getTodayActivity();

    expect(activity.stats).toMatchObject({ completed: 1, running: 1, successRate: 100 });
    expect(getAgentsByDate).not.toHaveBeenCalled();
  });
});
