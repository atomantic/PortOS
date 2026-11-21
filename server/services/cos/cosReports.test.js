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
vi.mock('./cosAgentIndex.js', async () => {
  const { projectArchivedAgent } = await import('../../lib/cos/cosAgentCompletionOrder.js');
  return {
    selectArchivedCompletions: vi.fn(async ({ dates }) => dates.flatMap(day =>
      (mock.agentsByDate[day] || []).map(agent => ({ id: agent.id, day, projection: projectArchivedAgent(agent) })))),
    readArchivedAgentMetadata: vi.fn(async (day, id) => (mock.agentsByDate[day] || []).find(a => a.id === id) || null),
  };
});

import { readArchivedAgentMetadata } from './cosAgentIndex.js';
import { getRecentTasks, getTodayActivity, getWhileAwayActivity } from './cosReports.js';

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

  it('keeps a relaunched run out of the incidents list', async () => {
    // The "While You Were Away" briefing is where a phantom failure is loudest:
    // it presents the failed bucket as incidents the user should look at.
    const relaunched = agentAt('swapped', { msAgo: 30 * 60000, success: false });
    relaunched.result = { ...relaunched.result, resumed: true, error: 'Relaunched by user on codex' };
    mock.state = stateWith([agentAt('ok', { msAgo: 10 * 60000, success: true }), relaunched]);

    const result = await getWhileAwayActivity(new Date(Date.now() - 3600000).toISOString());

    expect(result.stats).toMatchObject({ completed: 1, succeeded: 1, failed: 0, successRate: 100 });
    expect(result.incidents).toHaveLength(0);
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

  it('reads full records only for the cards it returns when the window is archived (#17309)', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    mock.agentsByDate[todayStr] = Array.from({ length: 20 }, (_, i) => agentAt(`arch${i}`, { msAgo: (i + 1) * 60000 }));

    const result = await getWhileAwayActivity(new Date(Date.now() - 3600000 * 3).toISOString());

    expect(result.stats.completed).toBe(20);
    expect(result.accomplishments).toHaveLength(8);
    expect(readArchivedAgentMetadata).toHaveBeenCalledTimes(8);
    expect(result.accomplishments[0].id).toBe('arch0');
  });

  it('skips the archive read entirely when every indexed id is still live (#3501)', async () => {
    const live = agentAt('a1', { msAgo: 30 * 60000 });
    mock.state = stateWith([live]);
    const todayStr = new Date().toISOString().slice(0, 10);
    mock.agentsByDate[todayStr] = [live]; // archived at completion, still in state

    const result = await getWhileAwayActivity(new Date(Date.now() - 3600000).toISOString());

    expect(result.stats.completed).toBe(1);
    expect(readArchivedAgentMetadata).not.toHaveBeenCalled();
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

// What Relaunch leaves behind: `resumeAgent` retires the running record with
// `success: false` and requeues the SAME task on the new provider. It never
// reached a verdict, so no report may count it as a failed task.
const handoffOnDate = (id, dateStr) => ({
  ...agentOnDate(id, dateStr, { success: false, desc: 'swapped providers mid-run' }),
  result: { success: false, duration: 3600000, resumed: true, resumedTaskId: `task-${id}`, error: 'Relaunched by user on codex' }
});

const todayStr = () => new Date().toISOString().slice(0, 10);

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
    expect(readArchivedAgentMetadata).not.toHaveBeenCalled();
  });

  it('does not count a live relaunched run as a failed task', async () => {
    const today = todayStr();
    mock.state = stateWith([agentOnDate('ok', today, { success: true }), handoffOnDate('swapped', today)]);

    const activity = await getTodayActivity();

    // The relaunch is neither a failure nor a total: the continuation it handed the task to records the outcome.
    expect(activity.stats).toMatchObject({ completed: 1, succeeded: 1, failed: 0 });
  });

  it('excludes an ARCHIVED relaunch too, not just a live one', async () => {
    const today = todayStr();
    mock.agentsByDate[today] = [handoffOnDate('archived-swap', today), agentOnDate('archived-ok', today, { success: true })];

    const activity = await getTodayActivity();

    expect(activity.stats).toMatchObject({ completed: 1, succeeded: 1, failed: 0 });
  });
});

describe('getRecentTasks', () => {
  beforeEach(() => {
    mock.daemonRunning = true;
    mock.agentsByDate = {};
    mock.state = stateWith([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('leaves a relaunched run out of the recent-task success split', async () => {
    // This reader has its own door into live state — it has no date window to
    // gate on, so it does not go through `collectCompletedAgents`. That made it
    // the last place still reporting a provider swap as a failed task after the
    // rest of the file stopped, on the /api/cos/insights recent-tasks panel.
    mock.state = stateWith([
      agentAt('ok', { msAgo: 10 * 60000, success: true }),
      { ...agentAt('swapped', { msAgo: 20 * 60000, success: false }),
        result: { success: false, duration: 60000, resumed: true, error: 'Relaunched by user on codex' } },
    ]);

    const result = await getRecentTasks();

    expect(result.tasks.map(t => t.id)).toEqual(['ok']);
    expect(result.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0, successRate: 100 });
  });

  it('still reports a genuine failure', async () => {
    mock.state = stateWith([
      agentAt('ok', { msAgo: 10 * 60000, success: true }),
      agentAt('broke', { msAgo: 20 * 60000, success: false }),
    ]);

    const result = await getRecentTasks();

    expect(result.summary).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
  });
});
