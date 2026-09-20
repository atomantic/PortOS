import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  goals: [],
  memory: { used: 1, total: 100 },
  processes: [],
  desktopProcessNames: new Set(),
  desktopLookupError: null,
  performance: { needsAttention: [], skipped: [] }
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
vi.mock('./usage.js', () => ({ getUsage: vi.fn(async () => ({ daily: [] })) }));
vi.mock('./tribe.js', () => ({ getCareSummary: vi.fn(async () => ({ overdueCount: 0, overdue: [] })) }));
vi.mock('./tribeOutreach.js', () => ({ findUnansweredTribeThreads: vi.fn(async () => []) }));
// Keep memory/CPU below their warning thresholds so only process alerts surface.
vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn(async () => mock.memory)
}));
vi.mock('./portosProductMetrics.js', () => ({
  getProductEngagement: vi.fn(async () => ({ actions: [] }))
}));

vi.mock('os', () => ({ default: { loadavg: () => [0], cpus: () => [{}] } }));

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
    expect(alerts[0].metadata).toEqual({ processId: 0, errored: 1, total: 2 });
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
      metadata: { skipped: 1, critical: 1 }
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
      'goal_stall:example%253Aone', 'goal_stall:example%3Aone', 'system_resource:memory'
    ]);
    mock.goals.reverse();
    mock.goals[0].title = 'Renamed goal';
    mock.memory = { used: 99, total: 100 };
    const next = await generateAlerts();
    expect(next.alerts.map(a => a.id).sort()).toEqual(first.alerts.map(a => a.id).sort());
    expect(next.alerts.find(a => a.id === 'system_resource:memory').severity).toBe('critical');
  });
});
