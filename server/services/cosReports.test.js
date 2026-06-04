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

vi.mock('./cosAgents.js', () => ({
  getAgentsByDate: vi.fn(async (date) => mock.agentsByDate[date] || [])
}));

import { getWhileAwayActivity } from './cosReports.js';

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
});
