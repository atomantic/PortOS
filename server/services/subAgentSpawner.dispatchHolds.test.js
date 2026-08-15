/**
 * The two dispatch HOLDS at the `task:ready` chokepoint, and what releases them.
 *
 * Both leave the task queued for a condition that clears on its own, rather than
 * failing it:
 *
 *  - Runner down. `portos-cos` is a separate PM2 app the user can stop from the
 *    Apps page, and in runner mode it owns every agent process. Dispatching into
 *    a stopped runner is not a task failure, but both spawn arms recorded it as
 *    one — see the `task:ready` listener in subAgentSpawner.js for the two
 *    failure modes.
 *  - Self-update in progress (issue #4124). `/api/update/execute` refuses to
 *    start while an agent is live, but `update.sh` then spends seconds in git
 *    pull / submodule update / npm install before `pm2 delete`. An agent spawned
 *    in that window is severed by the restart.
 *
 * The holds live in that listener, not inside `runAgentSpawn`, because a hold
 * below the spawn body's entry returns past `releaseAppReviewMarker` and strands
 * the synthetic "in review" marker for the whole outage (issue #989). The two
 * side effects the dequeue tiers already committed — that marker and the
 * scheduler's `spawningJobIds` reservation — are released here instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runnerHandlers = new Map();

vi.mock('./cosRunnerClient.js', () => ({
  onCosRunnerEvent: vi.fn((event, handler) => { runnerHandlers.set(event, handler); }),
  initCosRunnerConnection: vi.fn(),
  isRunnerAvailable: vi.fn().mockResolvedValue(true),
  isRunnerReachable: vi.fn().mockResolvedValue(true),
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn(), on: vi.fn((event, handler) => { taskHandlers.set(event, handler); }) },
}));

vi.mock('./providerStatus.js', () => ({ initProviderStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./agentRunnerSync.js', () => ({ syncRunnerAgents: vi.fn().mockResolvedValue(0) }));
vi.mock('./cosAgentLifecycle.js', () => ({ updateAgent: vi.fn() }));
vi.mock('./agentRunnerOutputBatchers.js', () => ({
  getRunnerOutputBatcher: vi.fn(),
  flushRunnerOutputBatcher: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentLifecycle.js', () => ({ handleAgentCompletion: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ cleanupOrphanedAgents: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn() }));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./updateChecker.js', () => ({ isUpdateInProgress: vi.fn().mockReturnValue(false) }));
vi.mock('./agentOrchestrator.js', () => ({
  completeAgent: vi.fn(),
  spawnAgentForTask: vi.fn().mockResolvedValue('agent-1'),
  terminateAgent: vi.fn(),
}));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

const taskHandlers = new Map();

import { initSpawner } from './subAgentSpawner.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { isRunnerReachable } from './cosRunnerClient.js';
import { spawnAgentForTask } from './agentOrchestrator.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { isUpdateInProgress } from './updateChecker.js';
import { setUseRunner } from './agentState.js';

const dispatch = (task) => taskHandlers.get('task:ready')(task);

describe('subAgentSpawner — runner-down hold', () => {
  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
    vi.useRealTimers();
    setUseRunner(true);
    isRunnerReachable.mockResolvedValue(true);
    isUpdateInProgress.mockReturnValue(false);
  });

  it('spawns normally while the runner is up', async () => {
    await dispatch({ id: 'cos-1', metadata: {} });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
  });

  it('holds the task instead of dispatching it while the runner is down', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-2', metadata: {} });

    // Never reaches the spawn body, so the task keeps its `pending` record: no
    // claim, no agent, no retry charged, no `spawn-rejected` finalization.
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  // Issue #989: the priority-0 tier binds a synthetic "in review" marker before
  // emitting `task:ready`. A hold that skipped this would leave the app reading
  // "in review" until the next daemon restart.
  it('releases the app-review marker the dequeue tier already bound', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-3', metadata: { app: 'some-app' } });

    expect(releaseAppReviewMarker).toHaveBeenCalledWith('some-app');
  });

  // cosJobScheduler reserves `spawningJobIds` before the emit and clears it on
  // `job:spawned` / `job:spawn-failed`. Without this the job stays wedged until
  // the scheduler's 5-minute spawn timeout — per job, per outage.
  it('frees an autonomous job\'s spawn reservation so its schedule re-registers', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-4', metadata: { jobId: 'job-7' } });

    expect(cosEvents.emit).toHaveBeenCalledWith('job:spawn-failed', { jobId: 'job-7' });
  });

  it('does not consult the runner in direct mode', async () => {
    setUseRunner(false);
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-5', metadata: {} });

    expect(isRunnerReachable).not.toHaveBeenCalled();
    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
  });
});

describe('subAgentSpawner — self-update hold (#4124)', () => {
  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
    vi.useRealTimers();
    setUseRunner(true);
    isRunnerReachable.mockResolvedValue(true);
    isUpdateInProgress.mockReturnValue(false);
  });

  it('holds the task instead of spawning into a process update.sh is about to restart', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-u1', metadata: {} });

    // No agent is created, and the task record is untouched — it stays
    // `pending` and is picked up by the first dequeue after the restart.
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  it('holds BEFORE the awaited runner probe, so nothing can race between check and spawn', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-u2', metadata: {} });

    expect(isRunnerReachable).not.toHaveBeenCalled();
  });

  it('releases the app-review marker and the job spawn reservation, same as the runner hold', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-u3', metadata: { app: 'some-app', jobId: 'job-9' } });

    expect(releaseAppReviewMarker).toHaveBeenCalledWith('some-app');
    expect(cosEvents.emit).toHaveBeenCalledWith('job:spawn-failed', { jobId: 'job-9' });
  });

  it('resumes spawning once the update settles — the hold is not sticky', async () => {
    isUpdateInProgress.mockReturnValue(true);
    await dispatch({ id: 'cos-u4', metadata: {} });
    expect(spawnAgentForTask).not.toHaveBeenCalled();

    isUpdateInProgress.mockReturnValue(false);
    await dispatch({ id: 'cos-u4', metadata: {} });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
  });

  it('holds in direct mode too, where there is no runner probe to hide behind', async () => {
    setUseRunner(false);
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-u5', metadata: {} });

    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });
});

describe('subAgentSpawner — runner connection events', () => {
  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
  });

  it('warns once when the runner drops, rather than once per held task', () => {
    runnerHandlers.get('connection:lost')();

    const warnings = emitLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toMatch(/CoS Runner disconnected/);
  });

  it('re-runs the dequeue when the runner returns, so held tasks spawn', async () => {
    vi.useFakeTimers();
    runnerHandlers.get('connection:ready')();
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();

    expect(cosEvents.emit).toHaveBeenCalledWith('cos:dequeue-requested');
  });

  // `reconnectionAttempts` is unbounded, so a crash-looping runner emits
  // `connect` repeatedly; each un-debounced edge would drive a full five-tier
  // dequeue cycle.
  it('coalesces a reconnect storm into one dequeue', async () => {
    vi.useFakeTimers();
    runnerHandlers.get('connection:ready')();
    runnerHandlers.get('connection:ready')();
    runnerHandlers.get('connection:ready')();
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();

    const dequeues = cosEvents.emit.mock.calls.filter(([event]) => event === 'cos:dequeue-requested');
    expect(dequeues).toHaveLength(1);
  });
});
