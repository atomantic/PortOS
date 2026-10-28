import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

const FIXED_NOW = new Date('2024-01-01T00:00:00.000Z');

const storeState = vi.hoisted(() => ({ data: { schedules: {} } }));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { agentPersonalities: '/unused' },
  createCachedStore: () => ({
    load: async () => storeState.data,
    mutate: async (fn) => {
      const result = await fn(storeState.data);
      if (result !== undefined) storeState.data = result;
      return storeState.data;
    },
    invalidateCache: () => {},
  }),
}));

vi.mock('./agentActivity.js', () => ({
  getTodayActionCount: vi.fn(async () => 0),
  logActivity: vi.fn(async () => {}),
}));

vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
}));

const {
  createSchedule,
  init,
  scheduleEvents,
  registerActionExecutor,
} = await import('./automationScheduler.js');

const { cancelAll, getEvent, BOOT_GRACE_MS } = await import('./eventScheduler.js');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  cancelAll();
  registerActionExecutor(async () => {});
  storeState.data = { schedules: {} };
  vi.setSystemTime(FIXED_NOW);
});

describe('automationScheduler interval schedules across restarts (#12624)', () => {
  it('schedules one full interval from now when schedule has never run', async () => {
    const intervalMs = 60 * 60 * 1000; // 1 hour
    const created = await createSchedule({
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: { text: 'hello' } },
      schedule: { type: 'interval', intervalMs },
      enabled: true,
    });

    const event = getEvent(`agent-schedule-${created.id}`);
    expect(event).toBeDefined();
    expect(event.lastRunAt).toBeNull();
    expect(event.nextRunAt).toBe(FIXED_NOW.getTime() + intervalMs);
  });

  it('preserves remaining interval countdown when last run was recent', async () => {
    const intervalMs = 60 * 60 * 1000; // 1 hour
    const pastRun = new Date(FIXED_NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20m ago

    // Seed store as if loaded from disk across a reboot
    const scheduleId = 'sched-interval-1';
    storeState.data.schedules[scheduleId] = {
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: {} },
      schedule: { type: 'interval', intervalMs },
      enabled: true,
      lastRun: pastRun,
      runCount: 1,
    };

    await init();

    const event = getEvent(`agent-schedule-${scheduleId}`);
    expect(event).toBeDefined();
    expect(event.lastRunAt).toBe(new Date(pastRun).getTime());
    // 20 min elapsed of 60 min -> 40 min remaining
    expect(event.nextRunAt).toBe(new Date(pastRun).getTime() + intervalMs);
    expect(event.nextRunAt).toBe(FIXED_NOW.getTime() + 40 * 60 * 1000);
  });

  it('runs BOOT_GRACE_MS after boot when interval is overdue', async () => {
    const intervalMs = 60 * 60 * 1000; // 1 hour
    const pastRun = new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago

    const scheduleId = 'sched-interval-overdue';
    storeState.data.schedules[scheduleId] = {
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: {} },
      schedule: { type: 'interval', intervalMs },
      enabled: true,
      lastRun: pastRun,
      runCount: 5,
    };

    await init();

    const event = getEvent(`agent-schedule-${scheduleId}`);
    expect(event).toBeDefined();
    expect(event.nextRunAt).toBe(FIXED_NOW.getTime() + BOOT_GRACE_MS);
  });

  it('produces exactly one run after back-to-back restarts within one interval', async () => {
    const intervalMs = 60 * 60 * 1000; // 1 hour
    const startRun = FIXED_NOW.toISOString();

    const scheduleId = 'sched-restarts';
    storeState.data.schedules[scheduleId] = {
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: {} },
      schedule: { type: 'interval', intervalMs },
      enabled: true,
      lastRun: startRun,
      runCount: 1,
    };

    const executed = [];
    scheduleEvents.on('execute', (e) => executed.push(e));

    // Boot 1 at T = 0
    await init();
    expect(getEvent(`agent-schedule-${scheduleId}`).nextRunAt).toBe(FIXED_NOW.getTime() + intervalMs);

    // Advance 20 minutes (T = 20m)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(executed).toHaveLength(0);

    // Restart 1: cancel active events and re-init
    cancelAll();
    await init();
    // Countdown should still aim at T = 60m (40m from now)
    expect(getEvent(`agent-schedule-${scheduleId}`).nextRunAt).toBe(FIXED_NOW.getTime() + intervalMs);

    // Advance another 20 minutes (T = 40m)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(executed).toHaveLength(0);

    // Restart 2: cancel active events and re-init
    cancelAll();
    await init();
    // Countdown should still aim at T = 60m (20m from now)
    expect(getEvent(`agent-schedule-${scheduleId}`).nextRunAt).toBe(FIXED_NOW.getTime() + intervalMs);

    // Advance 20 minutes to T = 60m
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(executed).toHaveLength(1);
    expect(executed[0].scheduleId).toBe(scheduleId);
  });
});

describe('automationScheduler random schedules across restarts (#12624)', () => {
  it('persists rolled interval and reuses it across restart instead of re-rolling', async () => {
    const randomWindow = { minMs: 30 * 60 * 1000, maxMs: 90 * 60 * 1000 };

    // Math.random returns 0.5 -> rolled interval = 30m + 0.5 * 60m = 60m
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const created = await createSchedule({
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: {} },
      schedule: { type: 'random', randomWindow },
      enabled: true,
    });

    const expectedInterval = 60 * 60 * 1000;
    const stored = storeState.data.schedules[created.id];
    expect(stored.rolledIntervalMs).toBe(expectedInterval);

    const eventBefore = getEvent(`agent-schedule-${created.id}`);
    expect(eventBefore.intervalMs).toBe(expectedInterval);

    // Change Math.random so a re-roll would produce a different interval (e.g. 0.9 -> 84m)
    Math.random.mockReturnValue(0.9);

    // Simulate restart
    cancelAll();
    await init();

    const storedAfterRestart = storeState.data.schedules[created.id];
    expect(storedAfterRestart.rolledIntervalMs).toBe(expectedInterval);

    const eventAfter = getEvent(`agent-schedule-${created.id}`);
    expect(eventAfter.intervalMs).toBe(expectedInterval);

    Math.random.mockRestore();
  });

  it('rolls a fresh random interval after the action executes', async () => {
    const randomWindow = { minMs: 10 * 60 * 1000, maxMs: 50 * 60 * 1000 };

    // First roll: Math.random = 0.25 -> 10 + 0.25 * 40 = 20 min
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.25);

    const created = await createSchedule({
      agentId: 'agent-1',
      accountId: 'acct-1',
      action: { type: 'post', params: {} },
      schedule: { type: 'random', randomWindow },
      enabled: true,
    });

    expect(storeState.data.schedules[created.id].rolledIntervalMs).toBe(20 * 60 * 1000);

    // Next roll should return 0.75 -> 10 + 0.75 * 40 = 40 min
    randomSpy.mockReturnValue(0.75);

    // Advance time by 20 min to trigger execution
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    const afterExec = storeState.data.schedules[created.id];
    expect(afterExec.runCount).toBe(1);
    expect(afterExec.rolledIntervalMs).toBe(40 * 60 * 1000);

    const nextEvent = getEvent(`agent-schedule-${created.id}`);
    expect(nextEvent.intervalMs).toBe(40 * 60 * 1000);

    randomSpy.mockRestore();
  });
});
