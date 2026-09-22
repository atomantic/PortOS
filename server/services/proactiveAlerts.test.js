import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  resolutions: [],
  goals: [],
  memory: { used: 1, total: 100 },
  processes: [],
  desktopProcessNames: new Set(),
  desktopLookupError: null,
  performance: { needsAttention: [], skipped: [] }
}));

vi.mock('./reviewQueueTriageStore.js', () => ({
  listReviewQueueTriage: vi.fn(async () => mock.resolutions),
  upsertReviewQueueTriage: vi.fn(async value => { mock.resolutions.push(value); return value; }),
}));
vi.mock('./identity.js', () => ({ getGoals: vi.fn(async () => ({ goals: mock.goals })) }));
vi.mock('./taskLearning.js', () => ({
  getPerformanceSummary: vi.fn(async () => mock.performance)
}));
vi.mock('./pm2.js', () => ({ listProcesses: vi.fn(async () => mock.processes) }));
// Mirrors the real annotateExpectedExit, including its fail-open behavior: a
// registry read failure marks nothing expected, so nothing is exempted.
vi.mock('./apps.js', () => ({
  annotateExpectedExit: vi.fn(async (processes) => {
    const names = mock.desktopLookupError ? new Set() : mock.desktopProcessNames;
    return processes.map(p => ({ ...p, expectedExit: names.has(p?.name) }));
  })
}));
vi.mock('./usage.js', () => ({ getUsage: vi.fn(() => ({ dailyActivity: {} })) }));
vi.mock('./tribe.js', () => ({ getCareSummary: vi.fn(async () => ({ overdueCount: 0, overdue: [] })) }));
vi.mock('./tribeOutreach.js', () => ({ findUnansweredTribeThreads: vi.fn(async () => []) }));
// Saturated resources remain telemetry, not an alert.
vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn(async () => mock.memory)
}));
vi.mock('./portosProductMetrics.js', () => ({
  getProductEngagement: vi.fn(async () => ({ actions: [] }))
}));

vi.mock('os', () => ({ default: { loadavg: () => [100], cpus: () => [{}] } }));

import { resolveHealthAlert } from './proactiveAlertSources.js';
import { getPerformanceSummary } from './taskLearning.js';
import { getUsage } from './usage.js';
import { generateAlerts } from './proactiveAlerts.js';

const processAlerts = async () => {
  const { alerts } = await generateAlerts();
  return alerts.filter(a => a.type === 'process_error');
};

describe('proactiveAlerts — desktop (GUI) process exemption (#2991)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.processes = [];
    mock.desktopProcessNames = new Set();
    mock.desktopLookupError = null;
    mock.performance = { needsAttention: [], skipped: [] };
  });

  it('does not alert when the only errored process is a quit game window', async () => {
    // Force-quitting a game leaves PM2 `errored`; that is a normal end to a play
    // session, not a failure to notify about.
    mock.processes = [{ pm_id: 1, name: 'game', status: 'errored' }];
    mock.desktopProcessNames = new Set(['game']);

    expect(await processAlerts()).toEqual([]);
  });

  it('still alerts on a genuinely errored web process', async () => {
    mock.processes = [{ pm_id: 0, name: 'web', status: 'errored' }];

    const alerts = await processAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].metadata.errored).toBe(1);
  });

  it('excludes the desktop process from both the count and the total', async () => {
    mock.processes = [
      { pm_id: 1, name: 'game', status: 'errored' },
      { pm_id: 0, name: 'web', status: 'errored' },
      { pm_id: 2, name: 'api', status: 'online' }
    ];
    mock.desktopProcessNames = new Set(['game']);

    const alerts = await processAlerts();
    expect(alerts).toHaveLength(1);
    // 1 of 2 — the game is not part of the denominator either, so the ratio
    // the user reads is not diluted by an exempt process.
    expect(alerts[0].metadata).toEqual({ processId: 0, processName: 'web', errored: 1, total: 2 });
  });

  it('does not report a desktop app restart loop as crashing', async () => {
    mock.processes = [{ pm_id: 1, name: 'game', status: 'online', unstableRestarts: 3 }];
    mock.desktopProcessNames = new Set(['game']);

    expect(await processAlerts()).toEqual([]);
  });

  it('still reports unstable restarts for a non-desktop process', async () => {
    mock.processes = [{ pm_id: 0, name: 'web', status: 'online', unstableRestarts: 3 }];

    const alerts = await processAlerts();
    expect(alerts).toHaveLength(1);
  });

  it('keeps per-process condition IDs through reorder, renaming and recovery', async () => {
    mock.processes = [
      { pm_id: 0, name: 'web', status: 'errored', unstableRestarts: 3 },
      { pm_id: 2, name: 'api', status: 'errored' }
    ];
    const first = await processAlerts();
    expect(first.map(a => a.id).sort()).toEqual([
      'process_crash_loop:0', 'process_errored:0', 'process_errored:2'
    ]);
    mock.processes = [
      { pm_id: 2, name: 'renamed api', status: 'errored' },
      { pm_id: 0, name: 'web', status: 'online', unstableRestarts: 4 }
    ];
    const second = await processAlerts();
    expect(second.map(a => a.id).sort()).toEqual(['process_crash_loop:0', 'process_errored:2']);
    expect(second.find(a => a.id === 'process_crash_loop:0').metadata.unstableRestarts).toBe(4);
  });

  it('reports missing process identity as unavailable rather than inventing a key', async () => {
    mock.processes = [{ name: 'web', status: 'errored' }];
    await expect(generateAlerts()).rejects.toThrow('Alert resource identity is unavailable');
  });

  it('alerts normally when the registry read fails (exempts nothing)', async () => {
    mock.processes = [{ pm_id: 0, name: 'web', status: 'errored' }];
    mock.desktopLookupError = new Error('registry unreadable');

    const alerts = await processAlerts();
    expect(alerts).toHaveLength(1);
  });
});

describe('proactiveAlerts — current task performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.processes = [];
    mock.desktopProcessNames = new Set();
    mock.desktopLookupError = null;
    mock.performance = { needsAttention: [], skipped: [] };
  });

  it('does not alert on a low historical rate when the task type has not run recently', async () => {
    const stale = {
      taskType: 'self-improve:example',
      successRate: 0,
      completed: 12,
      rateSource: 'lifetime',
      windowedCompleted: 0
    };
    mock.performance = { needsAttention: [stale], skipped: [stale] };

    const { alerts } = await generateAlerts();
    expect(alerts.filter(a => a.type === 'success_drop' || a.type === 'learning_health')).toEqual([]);
  });

  it('keeps alerts backed by enough runs in the current window', async () => {
    const active = {
      taskType: 'self-improve:example',
      successRate: 20,
      completed: 25,
      rateSource: 'windowed',
      windowedCompleted: 5
    };
    mock.performance = { needsAttention: [active], skipped: [active] };

    const { alerts } = await generateAlerts();
    expect(alerts.find(a => a.type === 'success_drop')).toMatchObject({
      detail: '20% success across the last 5 runs'
    });
    expect(alerts.find(a => a.type === 'learning_health')).toMatchObject({
      title: '1 task type being skipped: self-improve:example',
      detail: 'Very low success rates caused automatic skip (self-improve:example) — review task configuration',
      metadata: { skipped: 1, critical: 1, taskTypes: ['self-improve:example'] }
    });
  });

  it('names multiple skipped task types in title and detail', async () => {
    const task1 = {
      taskType: 'internal-task',
      successRate: 10,
      completed: 30,
      rateSource: 'windowed',
      windowedCompleted: 30
    };
    const task2 = {
      taskType: 'self-improve:claim-issue',
      successRate: 3,
      completed: 30,
      rateSource: 'windowed',
      windowedCompleted: 30
    };
    mock.performance = { needsAttention: [task1, task2], skipped: [task1, task2] };

    const { alerts } = await generateAlerts();
    expect(alerts.find(a => a.type === 'learning_health')).toMatchObject({
      title: '2 task types being skipped: internal-task, self-improve:claim-issue',
      detail: 'Very low success rates caused automatic skip (internal-task, self-improve:claim-issue) — review task configuration',
      metadata: { skipped: 2, critical: 2, taskTypes: ['internal-task', 'self-improve:claim-issue'] }
    });
  });
});

describe('proactiveAlerts — resource identities', () => {
  it('keys goals and resource conditions independently of their presentation', async () => {
    mock.processes = [];
    mock.performance = { needsAttention: [], skipped: [] };
    mock.goals = [
      { id: 'example:one', title: 'Same title', status: 'active', createdAt: '2020-01-01' },
      { id: 'example%3Aone', title: 'Same title', status: 'active', createdAt: '2020-01-01' }
    ];
    mock.memory = { used: 90, total: 100 };
    const first = await generateAlerts();
    expect(first.alerts.map(a => a.id).sort()).toEqual([
      'goal_stall:example%253Aone', 'goal_stall:example%3Aone'
    ]);
    mock.goals.reverse();
    mock.goals[0].title = 'Renamed goal';
    mock.memory = { used: 99, total: 100 };
    const next = await generateAlerts();
    expect(next.alerts.map(a => a.id).sort()).toEqual(first.alerts.map(a => a.id).sort());
    expect(next.alerts.some(a => a.type === 'system_resource')).toBe(false);
  });
});


describe('proactiveAlerts — activity is not spending evidence', () => {
  it('does not turn a busy day into a cost warning', async () => {
    const dailyActivity = {};
    for (let offset = 0; offset < 5; offset++) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      dailyActivity[date.toISOString().slice(0, 10)] = {
        tokens: offset === 0 ? 1_000_000 : 100,
        sessions: offset === 0 ? 1000 : 1,
      };
    }
    getUsage.mockReturnValue({ dailyActivity });
    const { alerts } = await generateAlerts();
    expect(alerts.filter(alert => alert.type === 'cost_spike')).toEqual([]);
  });
});


describe('health alert resolution', () => {
  beforeEach(() => {
    mock.resolutions = [];
    mock.goals = [];
    mock.performance = { needsAttention: [], skipped: [] };
    mock.desktopProcessNames = new Set();
    mock.desktopLookupError = null;
    mock.processes = [{ pm_id: 7, name: 'example-service', status: 'errored', restarts: 3 }];
  });

  it('keeps corrected evidence quiet and permits a new failure', async () => {
    expect(await resolveHealthAlert('process_errored:7')).toEqual({ resolved: true });
    expect(await processAlerts()).toEqual([]);
    expect(mock.resolutions[0]).toMatchObject({ actionKey: 'health.resolved:process_errored:7', dismissed: true });
    expect(mock.resolutions[0].revision).toMatch(/^[a-f0-9]{64}$/);
    mock.processes[0].restarts++;
    expect(await processAlerts()).toHaveLength(1);
  });

  it('passes the correction time into both run-based alert detectors', async () => {
    mock.performance = { needsAttention: [{ taskType: 'example:task', rateSource: 'windowed', successRate: 3, windowedCompleted: 30 }], skipped: [] };
    await resolveHealthAlert('success_drop:example%3Atask');
    const regenerated = await generateAlerts();
    expect(regenerated.alerts.find(alert => alert.id === 'success_drop:example%3Atask').occurrence)
      .toBe(mock.resolutions[0].occurrence);
    expect(getPerformanceSummary).toHaveBeenLastCalledWith({
      sinceByTaskType: { 'example:task': mock.resolutions[0].occurrence }, since: null,
    });
  });

  it('does not resurrect a stalled goal merely because another day passed', async () => {
    mock.goals = [{ id: 'example', title: 'Example goal', status: 'active', createdAt: '2020-01-01' }];
    await resolveHealthAlert('goal_stall:example');
    mock.goals[0].title = 'Renamed goal';
    const { alerts } = await generateAlerts();
    expect(alerts.some(alert => alert.type === 'goal_stall')).toBe(false);
    expect(await resolveHealthAlert('goal_stall:missing')).toBeNull();
  });
});
