import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  data: { schedules: {} },
  createPost: vi.fn(),
  logActivity: vi.fn(),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { agentPersonalities: '/unused' },
  createCachedStore: () => ({
    load: async () => fakes.data,
    mutate: async (fn) => { await fn(fakes.data); },
    invalidateCache: () => {},
  }),
  sleep: vi.fn(),
}));
vi.mock('./agentActivity.js', () => ({
  getTodayActionCount: async () => 0,
  logActivity: fakes.logActivity,
}));
vi.mock('./platformAccounts.js', () => ({
  getAccountWithCredentials: async () => ({
    platform: 'moltbook', status: 'active', credentials: { apiKey: 'synthetic-key' },
  }),
  recordActivity: async () => {},
}));
vi.mock('./agentPersonalities.js', () => ({
  getAgentById: async () => ({ id: 'example-agent', enabled: true }),
}));
vi.mock('../integrations/moltbook/index.js', () => ({
  createMoltbookClient: () => ({ createPost: fakes.createPost }),
}));
vi.mock('../integrations/moltworld/index.js', () => ({}));
vi.mock('./agentContentGenerator.js', () => ({}));
vi.mock('./agentFeedFilter.js', () => ({}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let automation;
let scheduler;
const scheduleInput = (overrides = {}) => ({
  agentId: 'example-agent',
  accountId: 'example-account',
  action: { type: 'post', params: { title: 'Example', content: 'Synthetic post', aiGenerate: false } },
  schedule: { type: 'interval', intervalMs: 1000 },
  enabled: true,
  ...overrides,
});

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  fakes.data = { schedules: {} };
  fakes.createPost.mockReset().mockResolvedValue({ id: 'example-post' });
  fakes.logActivity.mockReset().mockResolvedValue(undefined);
  automation = await import('./automationScheduler.js');
  scheduler = await import('./eventScheduler.js');
  const executor = await import('./agentActionExecutor.js');
  executor.init();
  executor.init(); // Reinitialization must replace registration, never multiply work.
});

afterEach(() => {
  scheduler.cancelAll();
  vi.useRealTimers();
});

describe('automation execution ownership (#13910)', () => {
  it('joins timer and Run Now work, runs other schedules independently, and drains terminal activity', async () => {
    const platform = deferred();
    const terminal = deferred();
    fakes.createPost.mockImplementationOnce(() => platform.promise);
    const first = await automation.createSchedule(scheduleInput());
    const other = await automation.createSchedule(scheduleInput({
      schedule: { type: 'interval', intervalMs: 60000 },
    }));
    fakes.logActivity.mockImplementation((entry) => (
      entry.scheduleId === first.id && entry.status === 'completed' ? terminal.promise : undefined
    ));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    let manualSettled = false;
    const manual = automation.runNow(first.id).then(() => { manualSettled = true; });
    await automation.runNow(other.id);
    expect(fakes.createPost).toHaveBeenCalledTimes(2);
    expect(manualSettled).toBe(false);

    scheduler.quiesce();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await expect(automation.runNow(other.id)).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(5000); // The existing shutdown grace may expire without losing ownership.
    expect(drained).toBe(false);
    expect(manualSettled).toBe(false);
    platform.resolve({ id: 'example-post' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: first.id, status: 'completed',
    }));
    expect(drained).toBe(false);
    expect(manualSettled).toBe(false);
    terminal.resolve();
    await Promise.all([manual, drain]);
    expect(fakes.createPost).toHaveBeenCalledTimes(2);
    expect(fakes.data.schedules[first.id].runCount).toBe(1);
    expect(scheduler.getEvent(`agent-schedule-${first.id}`).lastRunSucceeded).toBe(true);
  });

  it('keeps a manual run owned when editing the schedule replaces its timer', async () => {
    const platform = deferred();
    fakes.createPost.mockReturnValue(platform.promise);
    const schedule = await automation.createSchedule(scheduleInput());
    const manual = automation.runNow(schedule.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    await automation.updateSchedule(schedule.id, { rateLimit: { cooldownMs: 10 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    scheduler.quiesce();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    platform.resolve({ id: 'example-post' });
    await Promise.all([manual, drain]);
    expect(fakes.data.schedules[schedule.id].runCount).toBe(1);
    expect(fakes.logActivity.mock.calls.filter(([entry]) => entry.status === 'completed')).toHaveLength(1);
  });

  it('records uncertain write failures once without replaying them on scheduler restart', async () => {
    fakes.createPost.mockRejectedValue(new Error('Connection lost after request sent'));
    const schedule = await automation.createSchedule(scheduleInput());
    await automation.runNow(schedule.id);
    expect(fakes.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: schedule.id, status: 'failed', error: 'Connection lost after request sent',
    }));
    expect(fakes.data.schedules[schedule.id]).toMatchObject({
      runCount: 1, lastRun: '2024-01-01T00:00:00.000Z',
    });
    scheduler.cancelAll();
    await automation.init();
    await vi.advanceTimersByTimeAsync(999);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);

    await automation.toggleSchedule(schedule.id, false);
    await automation.runNow(schedule.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    expect(fakes.logActivity).toHaveBeenCalledTimes(2); // started and failed
  });

  it('releases ownership after a terminal-store failure without retrying the platform write', async () => {
    fakes.logActivity.mockImplementation(async (entry) => {
      if (entry.status === 'completed') throw new Error('Synthetic activity store unavailable');
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const schedule = await automation.createSchedule(scheduleInput({
      schedule: { type: 'random', randomWindow: { minMs: 120000, maxMs: 360000 } },
    }));
    random.mockReturnValue(0.5);
    await automation.runNow(schedule.id);
    expect(scheduler.getHistory({ eventId: `agent-schedule-${schedule.id}` })[0]).toMatchObject({
      success: false, error: 'Synthetic activity store unavailable',
    });
    expect(scheduler.getEvent(`agent-schedule-${schedule.id}`).intervalMs).toBe(240000);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    fakes.logActivity.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(239999);
    expect(fakes.createPost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // The next regular run is allowed; no failed write replay.
    expect(fakes.createPost).toHaveBeenCalledTimes(2);
    expect(fakes.data.schedules[schedule.id].runCount).toBe(2);
    random.mockRestore();
  });
});
