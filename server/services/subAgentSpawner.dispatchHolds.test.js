/**
 * The dispatch HOLDS at the `task:ready` chokepoint, and what releases them.
 *
 * Each leaves the task queued for a condition that clears on its own, rather
 * than failing it:
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
 *  - Forge unreachable (issue #5110). A task that promises a change request cannot
 *    finish with the forge down: the agent works, `git push` fails, and finalize
 *    records the non-actionable `forge-unreachable` — which retries, so one VPN
 *    drop re-ran the same agent three times before the task reached `blocked`.
 *
 *  - Local inference endpoint at capacity (issue #4834). A CoS agent runs a
 *    vendor CLI that talks to the local model server directly, so promptRunner's
 *    in-flight gate never sees it; two agents at one GPU takes an accelerator
 *    OOM. The slot is reserved across the spawn window and released after.
 *
 * The holds live in that listener, not inside `runAgentSpawn`, because a hold
 * below the spawn body's entry returns past `releaseAppReviewMarker` and strands
 * the synthetic "in review" marker for the whole outage (issue #989). The side
 * effects the dequeue tiers already committed — that marker, the scheduler's
 * `spawningJobIds` reservation, and a mission sub-task's `in_progress` flip —
 * are released here instead.
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
vi.mock('./missions.js', () => ({ releaseMissionSubTask: vi.fn().mockResolvedValue(null) }));
vi.mock('./cosState.js', () => ({ loadState: vi.fn().mockResolvedValue({ agents: {} }) }));
// The real slot module is covered end-to-end in cos.test.js (resolvers, running
// tally, reservations). Mocked here so this suite stays about the LISTENER's
// wiring — hold vs spawn vs release — and doesn't drag promptRunner's provider
// graph into a file that mocks providerStatus.
vi.mock('./cosLocalEndpointSlots.js', () => ({
  acquireLocalEndpointSpawnSlot: vi.fn().mockResolvedValue({ ok: true, release: vi.fn() }),
}));
// Same reason: the real gate reaches the app registry through agentPromptBuilder,
// whose graph reads files at module load and pulls in cos.js. Its own decisions
// (which statuses hold, which hosts are probed, the expiry) are covered directly
// in cosForgeSpawnGate.test.js; here it is a seam for the LISTENER's wiring.
vi.mock('./cosForgeSpawnGate.js', () => ({
  forgeSpawnHoldReason: vi.fn().mockResolvedValue(null),
}));
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
import { releaseMissionSubTask } from './missions.js';
import { setUseRunner } from './agentState.js';
import { acquireLocalEndpointSpawnSlot } from './cosLocalEndpointSlots.js';
import { forgeSpawnHoldReason } from './cosForgeSpawnGate.js';

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

/**
 * A mission task is the one dispatch shape with NO persisted record, so "leave
 * the task queued" cannot mean "do nothing" for it (issue #4858).
 *
 * `generateMissionTask` flips the selected sub-task to `in_progress` and saves
 * the mission before returning — the flip is what stops the next generation
 * cycle re-picking it. The task object it returns is the only copy; nothing
 * writes it to `COS-TASKS.md`. So a hold that skipped the revert would burn one
 * sub-task per occurrence: no queued record to re-dispatch, and generation only
 * ever selects `pending` sub-tasks, so the mission just stops advancing.
 *
 * The revert lives in `holdTask` rather than in any single hold branch, for the
 * same reason `job:spawn-failed` does — that is the one chokepoint every hold
 * funnels through, so a fourth hold inherits it for free.
 */
describe('subAgentSpawner — mission sub-task release (#4858)', () => {
  const missionTask = (id) => ({
    id,
    metadata: { missionId: 'mission-1', subTaskId: 'sub-3', isMissionTask: true },
  });

  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
    vi.useRealTimers();
    setUseRunner(true);
    isRunnerReachable.mockResolvedValue(true);
    isUpdateInProgress.mockReturnValue(false);
    releaseMissionSubTask.mockResolvedValue(null);
  });

  it('returns the sub-task to pending when the runner is down', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch(missionTask('cos-m1'));

    expect(spawnAgentForTask).not.toHaveBeenCalled();
    expect(releaseMissionSubTask).toHaveBeenCalledWith('mission-1', 'sub-3');
  });

  // The whole point of releasing in holdTask: every hold gets it, not just the
  // one whose branch happened to be written first.
  it('returns the sub-task to pending during a self-update too', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch(missionTask('cos-m2'));

    expect(releaseMissionSubTask).toHaveBeenCalledWith('mission-1', 'sub-3');
  });

  it('leaves the flip alone on a successful dispatch — the agent owns it now', async () => {
    await dispatch(missionTask('cos-m3'));

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
    expect(releaseMissionSubTask).not.toHaveBeenCalled();
  });

  it('does not touch missions for a held task that is not a mission task', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-m4', metadata: { jobId: 'job-2' } });

    expect(releaseMissionSubTask).not.toHaveBeenCalled();
  });

  // Both halves identify the record; a missionId alone can't address a sub-task,
  // and passing undefined through would make the helper scan for `undefined`.
  it('skips the release when the sub-task id is missing', async () => {
    isRunnerReachable.mockResolvedValue(false);

    await dispatch({ id: 'cos-m5', metadata: { missionId: 'mission-1' } });

    expect(releaseMissionSubTask).not.toHaveBeenCalled();
  });

  // holdTask runs outside the request lifecycle (a cosEvents listener), so a
  // rejected release must not escape as an unhandled rejection or swallow the
  // releases queued before it.
  it('logs and continues when the release fails', async () => {
    isRunnerReachable.mockResolvedValue(false);
    releaseMissionSubTask.mockRejectedValue(new Error('disk full'));

    await expect(dispatch({
      id: 'cos-m6',
      metadata: { missionId: 'mission-1', subTaskId: 'sub-3', app: 'some-app' },
    })).resolves.not.toThrow();

    expect(releaseAppReviewMarker).toHaveBeenCalledWith('some-app');
    const warnings = emitLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnings.some(([, message]) => /release mission sub-task sub-3/.test(message))).toBe(true);
  });
});

describe('subAgentSpawner — local-endpoint capacity hold (#4834)', () => {
  // A CoS agent runs a vendor CLI that opens its own connection to the local
  // model server, so promptRunner's in-flight gate never sees it. The hold lives
  // at this listener rather than in `dequeueNextTask` because six other emitters
  // (evaluateTasks, forceSpawnTask, the job scheduler, the Creative Director
  // bridge, …) reach the spawner without passing through the scheduler at all.
  let release;

  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
    vi.useRealTimers();
    setUseRunner(true);
    isRunnerReachable.mockResolvedValue(true);
    isUpdateInProgress.mockReturnValue(false);
    release = vi.fn();
    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: true, release });
  });

  it('spawns and releases the reserved slot when one is available', async () => {
    await dispatch({ id: 'cos-l1', metadata: {} });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds the task instead of dispatching a second agent at a saturated GPU', async () => {
    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: false, reason: 'local endpoint http://localhost:1234/v1 is at capacity (1/1)' });

    await dispatch({ id: 'cos-l2', metadata: {} });

    // Held, not failed: the task record stays `pending`, so the next dequeue
    // tick re-picks it once the running agent frees the endpoint.
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  it('releases the app-review marker and the job reservation, same as the other holds', async () => {
    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: false, reason: 'at capacity' });

    await dispatch({ id: 'cos-l3', metadata: { app: 'some-app', jobId: 'job-11' } });

    expect(releaseAppReviewMarker).toHaveBeenCalledWith('some-app');
    expect(cosEvents.emit).toHaveBeenCalledWith('job:spawn-failed', { jobId: 'job-11' });
  });

  it('releases the slot even when the spawn throws', async () => {
    // Without the `finally`, a failed spawn would leak the reservation and wedge
    // the endpoint until the process restarts.
    spawnAgentForTask.mockRejectedValueOnce(new Error('boom'));

    await dispatch({ id: 'cos-l4', metadata: {} });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('checks capacity AFTER the update and runner holds, which are cheaper', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-l5', metadata: {} });

    expect(acquireLocalEndpointSpawnSlot).not.toHaveBeenCalled();
  });

  it('resumes spawning once the endpoint frees up — the hold is not sticky', async () => {
    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: false, reason: 'at capacity' });
    await dispatch({ id: 'cos-l6', metadata: {} });
    expect(spawnAgentForTask).not.toHaveBeenCalled();

    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: true, release });
    await dispatch({ id: 'cos-l6', metadata: {} });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
  });
});

describe('subAgentSpawner — forge-unreachable hold (#5110)', () => {
  // The pre-gate behavior: an agent whose task promises a change request did the
  // work, failed to push, and finalized the non-actionable `forge-unreachable` —
  // which retries, so one VPN drop re-ran the same 20-to-100-minute agent three
  // times before the task reached `blocked`.
  beforeEach(async () => {
    await initSpawner();
    vi.clearAllMocks();
    vi.useRealTimers();
    setUseRunner(true);
    isRunnerReachable.mockResolvedValue(true);
    isUpdateInProgress.mockReturnValue(false);
    acquireLocalEndpointSpawnSlot.mockResolvedValue({ ok: true, release: vi.fn() });
    forgeSpawnHoldReason.mockResolvedValue(null);
  });

  it('spawns normally when the gate declines to hold', async () => {
    await dispatch({ id: 'cos-f1', metadata: { openPR: true } });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
  });

  it('holds instead of dispatching an agent that cannot push what it builds', async () => {
    forgeSpawnHoldReason.mockResolvedValue('forge.example.com is unreachable');

    await dispatch({ id: 'cos-f2', metadata: { openPR: true } });

    // Held, not failed: no agent, no retry charged, so the task keeps its full
    // retry budget for a failure that is actually about the task.
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  it('releases the app-review marker and the job reservation, same as the other holds', async () => {
    forgeSpawnHoldReason.mockResolvedValue('forge.example.com is unreachable');

    await dispatch({ id: 'cos-f3', metadata: { openPR: true, app: 'some-app', jobId: 'job-13' } });

    expect(releaseAppReviewMarker).toHaveBeenCalledWith('some-app');
    expect(cosEvents.emit).toHaveBeenCalledWith('job:spawn-failed', { jobId: 'job-13' });
  });

  it('holds BEFORE reserving a capacity slot, so a held task never books one', async () => {
    forgeSpawnHoldReason.mockResolvedValue('forge.example.com is unreachable');

    await dispatch({ id: 'cos-f4', metadata: { openPR: true } });

    expect(acquireLocalEndpointSpawnSlot).not.toHaveBeenCalled();
  });

  it('probes the forge AFTER the update and runner holds, which are cheaper', async () => {
    isUpdateInProgress.mockReturnValue(true);

    await dispatch({ id: 'cos-f5', metadata: { openPR: true } });

    expect(forgeSpawnHoldReason).not.toHaveBeenCalled();
  });

  it('resumes spawning once the forge returns — the hold is not sticky', async () => {
    forgeSpawnHoldReason.mockResolvedValue('forge.example.com is unreachable');
    await dispatch({ id: 'cos-f6', metadata: { openPR: true } });
    expect(spawnAgentForTask).not.toHaveBeenCalled();

    forgeSpawnHoldReason.mockResolvedValue(null);
    await dispatch({ id: 'cos-f6', metadata: { openPR: true } });

    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
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
