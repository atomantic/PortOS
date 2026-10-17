import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn(), on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./apps.js', async (original) => ({
  ...(await original()), getActiveApps: vi.fn(async () => [{ id: 'example-app', name: 'Example App' }])
}));
vi.mock('./appActivity.js', async (original) => ({
  ...(await original()), loadAppActivity: vi.fn(async () => ({ apps: {} }))
}));
vi.mock('./taskSchedule.js', async (original) => ({
  ...(await original()), getDueTasks: vi.fn(), recordExecution: vi.fn(async () => {})
}));

import { queueEligibleImprovementTasks } from './cosTaskGenerator.js';
import { getDueTasks, recordExecution } from './taskSchedule.js';
import { loadAppActivity } from './appActivity.js';
import { getActiveApps } from './apps.js';
import { cosEvents } from './cosEvents.js';

const state = { config: { improvementEnabled: true, appReviewCooldownMs: 60_000 } };
const dueCron = taskType => ({ taskType, reason: 'cron-due', interval: { type: 'cron' } });
const drain = { taskType: 'security', reason: 'perpetual-drain', interval: { type: 'on-demand', perpetual: true } };
const queuedTask = (analysisType, status = 'pending') => ({
  id: `sys-example-${analysisType}`, status, metadata: { app: 'example-app', analysisType }
});
let due;
let prepareTask;
let persistTask;

beforeEach(() => {
  vi.clearAllMocks();
  due = [dueCron('do-release')];
  getDueTasks.mockImplementation(async appId => appId ? due : []);
  loadAppActivity.mockResolvedValue({ apps: {} });
  prepareTask = vi.fn(async taskType => ({
    task: { description: `Run ${taskType}\nFull instructions`, metadata: { app: 'example-app', analysisType: taskType } },
    pendingPerpetualDispatch: null
  }));
  persistTask = vi.fn(async task => ({ ...task }));
});
const run = (tasks = [], options = {}) => queueEligibleImprovementTasks(state, { tasks }, { prepareTask, persistTask, ...options });

describe('scheduled managed-app queue admission', () => {
  it.each(['pending', 'in_progress', 'blocked'])('captures a clock slot while unrelated work is %s', async status => {
    await run([queuedTask('observability', status)]);
    expect(persistTask).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'LOW', description: 'Run do-release\nFull instructions', metadata: { app: 'example-app', analysisType: 'do-release' }
    }), 'internal', { raw: true, ignoreTaskId: null, suppressDequeue: true });
    expect(recordExecution).toHaveBeenCalledExactlyOnceWith('task:do-release', 'example-app');
    expect(cosEvents.emit).toHaveBeenCalledWith('cos:dequeue-requested');
  });

  it('captures every simultaneous cron, including an app override, during app cooldown', async () => {
    due = [dueCron('do-release'), { ...dueCron('pr-watcher'), interval: { type: 'on-demand' } }, drain];
    loadAppActivity.mockResolvedValue({ apps: { 'example-app': { cooldownUntil: new Date(Date.now() + 60_000).toISOString() } } });
    await run();
    expect(persistTask.mock.calls.map(([task]) => task.metadata.analysisType)).toEqual(['do-release', 'pr-watcher']);
    expect(recordExecution).toHaveBeenCalledTimes(2);
    // A later tick sees the persisted tasks even after their clock window closes.
    due = [drain];
    await run(persistTask.mock.calls.map(([task]) => ({ ...task, status: 'pending' })));
    expect(persistTask).toHaveBeenCalledTimes(2);
  });

  it.each(['pending', 'in_progress', 'blocked'])('keeps same-type %s dedup while allowing a sibling clock slot', async status => {
    due = [dueCron('do-release'), dueCron('pr-watcher')];
    await run([queuedTask('do-release', status)]);
    expect(prepareTask.mock.calls.map(([type]) => type)).toEqual(['pr-watcher']);
    expect(recordExecution).toHaveBeenCalledExactlyOnceWith('task:pr-watcher', 'example-app');
  });

  it('does not consume cadence for generator declines or disk-level duplicate races', async () => {
    due = [dueCron('do-release'), dueCron('pr-watcher')];
    prepareTask.mockResolvedValueOnce({ task: null });
    persistTask.mockResolvedValueOnce({ duplicate: true });
    await run();
    expect(recordExecution).not.toHaveBeenCalled();
    expect(cosEvents.emit).not.toHaveBeenCalled();
  });

  describe('multi-app tick', () => {
    afterEach(() => {
      vi.useRealTimers();
      getActiveApps.mockResolvedValue([{ id: 'example-app', name: 'Example App' }]);
    });

    it('queues every app on a shared cron slot even when earlier preparation outlasts the minute, once per minute', async () => {
      const slotStart = new Date('2026-09-09T11:30:05Z').getTime();
      const inSlot = now => Math.floor(now / 60_000) === Math.floor(slotStart / 60_000);
      vi.useFakeTimers();
      vi.setSystemTime(slotStart);
      const apps = [{ id: 'app-1', name: 'App One' }, { id: 'app-2', name: 'App Two' }];
      getActiveApps.mockResolvedValue(apps);
      // Readiness is judged against the clock the caller supplies, as the real gate does.
      const lastRun = {};
      getDueTasks.mockImplementation(async (appId, { now = Date.now() } = {}) =>
        appId && inSlot(now) && !lastRun[appId] ? [dueCron('do-release')] : []);
      recordExecution.mockImplementation(async (_key, appId) => { lastRun[appId] = Date.now(); });
      prepareTask.mockImplementation(async (taskType, app) => {
        vi.advanceTimersByTime(90_000);
        return { task: { description: taskType, metadata: { app: app.id, analysisType: taskType } }, pendingPerpetualDispatch: null };
      });

      await run();
      expect(persistTask.mock.calls.map(([task]) => task.metadata.app)).toEqual(['app-1', 'app-2']);
      expect(getDueTasks.mock.calls.filter(([id]) => id).every(([, opts]) => opts.now === slotStart)).toBe(true);

      // A later tick must not re-queue an occurrence that was already recorded.
      persistTask.mockClear();
      await run();
      expect(persistTask).not.toHaveBeenCalled();
    });
  });

  it('retains one background drain per app and holds it behind unrelated work', async () => {
    due = [drain, { ...drain, taskType: 'observability' }];
    await run([queuedTask('existing-work')]);
    expect(persistTask).not.toHaveBeenCalled();
    await run();
    expect(persistTask).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledExactlyOnceWith('task:security', 'example-app');
  });

  it('forwards completion exclusions and respects a disabled improvement gate', async () => {
    await run([queuedTask('do-release', 'in_progress')], { ignoreTaskId: 'sys-example-do-release', wakeAfterRecord: false });
    expect(prepareTask).toHaveBeenCalledWith('do-release', expect.anything(), state, { ignoreTaskId: 'sys-example-do-release' });
    expect(cosEvents.emit).not.toHaveBeenCalled();
    persistTask.mockClear();
    await queueEligibleImprovementTasks({ config: { improvementEnabled: false } }, { tasks: [] }, { prepareTask, persistTask });
    expect(persistTask).not.toHaveBeenCalled();
  });
});
