/**
 * Improvement-queue selection failures are logged, not swallowed (#11444).
 *
 * `queueEligibleImprovementTasks` asks `getNextTaskType` for each app. A
 * rejection there used to be `.catch(() => null)`, which skipped the app with
 * no trace. These cases pin that the failure is logged with the app id and the
 * error message, and that the per-app loop keeps going for the other apps.
 *
 * Isolated file so the taskSchedule double can't leak into the shared
 * cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const emitLog = vi.fn();
vi.mock('./cosEvents.js', async (importActual) => ({
  ...(await importActual()),
  cosEvents: { emit: vi.fn(), on: vi.fn() },
  emitLog: (...args) => emitLog(...args),
}));

const getNextTaskType = vi.fn();
vi.mock('./taskSchedule.js', async (importActual) => ({
  ...(await importActual()),
  getDueTasks: vi.fn(async () => []),
  getNextTaskType: (...args) => getNextTaskType(...args),
  recordExecution: vi.fn(async () => {}),
}));

const APPS = [
  { id: 'app-broken', name: 'Broken App' },
  { id: 'app-ok', name: 'Healthy App' },
];
vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getActiveApps: vi.fn(async () => APPS),
}));

vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  loadAppActivity: vi.fn(async () => ({ apps: {} })),
}));

vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  isImprovementEnabled: vi.fn(() => true),
}));

const { queueEligibleImprovementTasks } = await import('./cosTaskGenerator.js');

const state = { config: {} };
const cosTaskData = { tasks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getNextTaskType.mockImplementation(async (appId) => {
    if (appId === 'app-broken') throw new Error('schedule descriptor is malformed');
    return { taskType: 'security' };
  });
});

describe('queueEligibleImprovementTasks next-type selection failures', () => {
  it('logs the app id and error message when getNextTaskType rejects, and keeps evaluating other apps', async () => {
    // Injected preparer: returning no task keeps the test off the spawn/persist path.
    const prepareTask = vi.fn(async () => ({ task: null }));
    const persistTask = vi.fn();

    await expect(queueEligibleImprovementTasks(state, cosTaskData, {
      prepareTask, persistTask,
    })).resolves.toBeUndefined();

    expect(emitLog).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('schedule descriptor is malformed'),
      { appId: 'app-broken' }
    );
    expect(emitLog.mock.calls.find(([level]) => level === 'error')[1]).toContain('Broken App');

    // The failed app produced no task, but the loop still reached the healthy app.
    expect(prepareTask).toHaveBeenCalledTimes(1);
    expect(prepareTask.mock.calls[0][0]).toBe('security');
    expect(prepareTask.mock.calls[0][1]).toMatchObject({ id: 'app-ok' });
    expect(persistTask).not.toHaveBeenCalled();
  });
});
