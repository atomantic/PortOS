/**
 * #14170 — once SIGTERM latches host shutdown, CoS admits no further agent.
 * An owner registered after the shutdown marker snapshot is charged as a
 * genuine orphan on the next boot, so the dequeue tiers, the immediate user
 * spawn, "Run now", and the completion continuation all stop at the latch,
 * before any tier side effect, task write, or `task:ready` emit.
 *
 * Drives the real cos.js entry points and listeners. `loadState` is the probe:
 * every admission path reads it before doing anything else, so zero reads with
 * the latch set means no tier ran. Own file because the module-wide
 * `cosState.js` mock would replace helpers cos.test.js exercises for real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('./cosState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureDirectories: vi.fn(async () => {}),
  isDaemonRunning: () => true,
  // Paused with no free slot: without the latch each path reads state and
  // stops there, so the control cases stay free of real spawn work.
  loadState: vi.fn(async () => ({ paused: true, running: false, agents: {}, config: { maxConcurrentAgents: 0 } })),
}));
vi.mock('./cosTaskStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getTaskById: vi.fn(async (id) => ({ id, status: 'pending', taskType: 'user', metadata: {} })),
}));

const { init, dequeueNextTask, forceSpawnTask } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { loadState } = await import('./cosState.js');
const { getTaskById } = await import('./cosTaskStore.js');
const { setUseRunner, useRunner } = await import('./agentState.js');
const { markHostShuttingDown, resetHostShutdownFlagForTests } = await import('../lib/hostShutdown.js');

const originalUseRunner = useRunner;
// The listeners schedule with setImmediate and chain a few promise hops.
const drainScheduled = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
};
const taskReadyEmits = (emit) => emit.mock.calls.filter(([event]) => event === 'task:ready');
const completedAgent = { id: 'agent-done', result: { success: true }, metadata: {} };

describe('CoS admission under host shutdown (#14170)', () => {
  let emit;

  beforeAll(async () => {
    setUseRunner(false);
    await init();
  });

  beforeEach(async () => {
    // Let init's own deferred work settle before counting reads.
    await drainScheduled();
    setUseRunner(false);
    vi.mocked(loadState).mockClear();
    vi.mocked(getTaskById).mockClear();
    emit = vi.spyOn(cosEvents, 'emit');
  });

  afterEach(() => {
    resetHostShutdownFlagForTests();
    emit.mockRestore();
    setUseRunner(originalUseRunner);
  });

  it('dequeueNextTask runs no tier once the latch is set', async () => {
    await dequeueNextTask();
    expect(loadState).toHaveBeenCalled();

    vi.mocked(loadState).mockClear();
    markHostShuttingDown();
    await dequeueNextTask();
    expect(loadState).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('forceSpawnTask refuses before reading or writing the task', async () => {
    markHostShuttingDown();
    const result = await forceSpawnTask('task-run-now', { resetSpawnBudget: true });

    expect(result).toEqual({ error: expect.stringContaining('shutting down') });
    expect(getTaskById).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('a newly added user task is not spawned immediately', async () => {
    markHostShuttingDown();
    cosEvents.emit('tasks:changed', { action: 'added', type: 'user', task: { id: 'task-new', metadata: {} } });
    await drainScheduled();

    expect(loadState).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('a completion refills and dequeues only while the server is up', async () => {
    cosEvents.emit('agent:completed', completedAgent);
    await drainScheduled();
    expect(loadState).toHaveBeenCalled();

    vi.mocked(loadState).mockClear();
    markHostShuttingDown();
    cosEvents.emit('agent:completed', completedAgent);
    await drainScheduled();
    expect(loadState).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });
});
