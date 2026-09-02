import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({}));

vi.mock('node:fs/promises', () => ({
  statfs: vi.fn(async () => ({
    blocks: 100,
    bsize: 1,
    bavail: 100 - sources.diskPercent,
  })),
}));
vi.mock('./apps.js', () => ({
  getAppStatuses: vi.fn(async () => sources.apps),
  getAllApps: vi.fn(async () => sources.appConfig),
}));
vi.mock('./cos.js', () => ({
  getAgents: vi.fn(async () => sources.agents),
  getCosTasks: vi.fn(async () => sources.taskState),
  getStatus: vi.fn(async () => sources.cosStatus),
  getTodayActivity: vi.fn(async () => sources.todayActivity),
}));
vi.mock('./review.js', () => ({ getPendingCounts: vi.fn(async () => sources.review) }));
vi.mock('./instances.js', () => ({ getPeers: vi.fn(async () => sources.peers) }));
vi.mock('./instanceFeatures.js', () => ({
  getInstanceFeatures: vi.fn(async () => sources.featuresState),
}));
vi.mock('./backup.js', () => ({ getState: vi.fn(async () => sources.backupState) }));
vi.mock('./notifications.js', () => ({
  getCountsByType: vi.fn(async () => sources.notifications),
}));
vi.mock('./character.js', () => ({ getCharacter: vi.fn(async () => sources.character) }));
vi.mock('./voice/config.js', () => ({
  getVoiceConfig: vi.fn(async () => sources.voiceConfig),
}));
vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn(async () => sources.memory),
}));
vi.mock('./identity.js', () => ({ getGoals: vi.fn(async () => sources.goalsData) }));
vi.mock('./productivity.js', () => ({
  getActivityCalendar: vi.fn(async () => sources.activityCalendar),
  getVelocityMetrics: vi.fn(async () => sources.velocity),
}));
vi.mock('./brainGraph.js', () => ({
  getBrainGraphOverview: vi.fn(async () => sources.memoryGraph),
}));
vi.mock('./brainStorage.js', () => ({
  getInboxLogCounts: vi.fn(async () => sources.inboxCounts),
}));
vi.mock('./dataIntrospection.js', () => ({
  getDataIntrospection: vi.fn(async () => sources.introspection),
}));
vi.mock('./jira.js', () => ({
  fetchMyCurrentSprintTickets: vi.fn(async () => []),
}));

const { collectEidoverseWorldSources } = await import('./eidoverseWorldSources.js');

beforeEach(() => {
  Object.assign(sources, {
    apps: [{ id: 'app-example', overallStatus: 'online', managed: true }],
    appConfig: [],
    agents: [],
    taskState: { tasks: [], awaitingApproval: [] },
    cosStatus: { running: false, paused: false, activeAgents: 0, pausedAgents: 0 },
    review: { total: 0, cos: 0, alert: 0 },
    featuresState: { features: [] },
    peers: [],
    backupState: { status: 'complete', filesChanged: 0 },
    notifications: { total: 0, unread: 0 },
    character: { level: 1 },
    voiceConfig: { enabled: false },
    memory: { total: 100, used: 10 },
    diskPercent: 10,
    todayActivity: null,
    velocity: null,
    activityCalendar: { weeks: [] },
    goalsData: { goals: [] },
    memoryGraph: { nodes: [], edges: [], hasEmbeddings: false },
    inboxCounts: { total: 0, needs_review: 0, classifying: 0 },
    introspection: {
      db: { tables: [], sizeBytes: 0, migrations: { applied: 0 } },
      fs: { domains: [], totalBytes: 0, totalFiles: 0 },
    },
  });
});

describe('Eidoverse world source aggregation', () => {
  it.each([
    ['critical disk usage', { diskPercent: 95 }, 'error'],
    ['failed backup', { backupState: { status: 'failed' } }, 'error'],
    ['warning disk usage', { diskPercent: 85 }, 'attention'],
    ['stopped app', { apps: [{ id: 'app-example', overallStatus: 'stopped' }] }, 'attention'],
    ['healthy inputs', {}, 'healthy'],
  ])('maps %s to the Nexus health state', async (_case, overrides, expected) => {
    Object.assign(sources, overrides);

    const result = await collectEidoverseWorldSources();

    expect(result.health.status).toBe(expected);
  });

  it.each([
    ['failed backup', { backupState: { status: 'failed' } }, 'error'],
    ['review alert', { review: { total: 1, cos: 0, alert: 1 } }, 'attention'],
    ['running CoS', { cosStatus: { running: true, paused: false, activeAgents: 1 } }, 'active'],
    ['idle system', {}, 'steady'],
  ])('maps %s to the operations signal', async (_case, overrides, expected) => {
    Object.assign(sources, overrides);

    const result = await collectEidoverseWorldSources();

    expect(result.operations).toEqual([
      expect.objectContaining({ id: 'overview', status: expected }),
    ]);
  });

  it('distinguishes unreadable sources from confirmed empty sources', async () => {
    Object.assign(sources, {
      goalsData: null,
      memoryGraph: null,
      activityCalendar: null,
    });
    const unreadable = await collectEidoverseWorldSources();

    expect(unreadable).toMatchObject({
      goals: null,
      memory: null,
      activity: null,
    });

    Object.assign(sources, {
      goalsData: { goals: [] },
      memoryGraph: { nodes: [], edges: [] },
      activityCalendar: { weeks: [] },
    });
    const empty = await collectEidoverseWorldSources();

    expect(empty).toMatchObject({
      goals: [],
      memory: [],
      activity: [],
    });
  });

  it('groups app status without exposing app names', async () => {
    sources.apps = [
      { id: 'app-one', name: 'Example Secret One', overallStatus: 'online', managed: true },
      { id: 'app-two', name: 'Example Secret Two', overallStatus: 'online', managed: false },
      { id: 'app-three', name: 'Example Secret Three', overallStatus: 'stopped', managed: true },
    ];

    const result = await collectEidoverseWorldSources();

    expect(result.apps).toEqual([
      { id: 'apps-active', label: 'Managed app group', status: 'active', count: 2, managed: 1 },
      { id: 'apps-attention', label: 'Managed app group', status: 'attention', count: 1, managed: 1 },
    ]);
    expect(JSON.stringify(result.apps)).not.toContain('Example Secret');
  });

  it('orders recent active days first after the activity summary', async () => {
    sources.activityCalendar = {
      weeks: [[
        { date: '2026-01-01', tasks: 1, successes: 1 },
        { date: '2026-01-02', tasks: 0, successes: 0 },
        { date: '2026-01-03', tasks: 3, successes: 2, isToday: true },
      ]],
      summary: { activeDays: 2, totalTasks: 4, totalSuccesses: 3 },
      maxTasks: 3,
    };

    const result = await collectEidoverseWorldSources();

    expect(result.activity[0]).toMatchObject({ id: 'summary', activeDays: 2 });
    expect(result.activity.slice(1).map(({ tasks }) => tasks)).toEqual([3, 1]);
  });

  it('emits a bounded productivity aggregate rather than task records', async () => {
    sources.todayActivity = {
      stats: { completed: 3, succeeded: 2, failed: 1, successRate: 67 },
      isRunning: true,
      isPaused: false,
    };
    sources.velocity = { velocity: 1.5, avgPerDay: 2, historicalDays: 7 };
    sources.taskState = {
      tasks: [
        { id: 'task-one', title: 'Example private task', status: 'pending' },
        { id: 'task-two', title: 'Example completed task', status: 'completed' },
      ],
      awaitingApproval: [{ id: 'approval-one' }],
    };

    const result = await collectEidoverseWorldSources();

    expect(result.productivity).toEqual([
      expect.objectContaining({
        id: 'summary',
        completedToday: 3,
        succeededToday: 2,
        failedToday: 1,
        queue: { pendingApprovals: 1, pendingTasks: 1, total: 2 },
        running: true,
      }),
    ]);
    expect(JSON.stringify(result.productivity)).not.toContain('Example private task');
  });
});
