/**
 * Mid-life runner promotion (issue #4134).
 *
 * `portos-cos` is a separate PM2 app, so it can come up AFTER `portos-server`.
 * Spawn mode used to be decided once, by the boot probe, with the socket and its
 * connection events wired only inside that `if (runnerAvailable)` branch — so a
 * server that booted while the runner was down stayed in direct mode for its
 * whole lifetime: every agent a child of `portos-server`, dying with it, which
 * is the exact orphaning runner mode exists to prevent.
 *
 * The socket is now always opened and the probe is only the cold-start seed;
 * `connection:ready` is the standing authority. The reverse edge is deliberately
 * NOT symmetric — `connection:lost` keeps runner mode so dispatch keeps HOLDING
 * tasks as `pending`, because demoting there would silently turn every held task
 * back into an orphan-prone direct spawn.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runnerHandlers = new Map();

vi.mock('./cosRunnerClient.js', () => ({
  onCosRunnerEvent: vi.fn((event, handler) => { runnerHandlers.set(event, handler); }),
  initCosRunnerConnection: vi.fn(),
  // The runner is DOWN at boot — the regression's starting condition.
  isRunnerAvailable: vi.fn().mockResolvedValue(false),
  isRunnerReachable: vi.fn().mockResolvedValue(false),
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn(), on: vi.fn() },
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
// Same reason cosLocalEndpointSlots is mocked in the dispatch-holds suite: the
// real gate reaches the app registry through agentPromptBuilder, whose graph
// reads files at module load — which this file's `fs` mock breaks. The gate's own
// behavior is covered in cosForgeSpawnGate.test.js.
vi.mock('./cosForgeSpawnGate.js', () => ({ forgeSpawnHoldReason: vi.fn().mockResolvedValue(null) }));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

import { initSpawner } from './subAgentSpawner.js';
import { initCosRunnerConnection } from './cosRunnerClient.js';
import { syncRunnerAgents } from './agentRunnerSync.js';
import { cosEvents, emitLog } from './cosEvents.js';
import * as agentState from './agentState.js';

// Read through the module namespace: `useRunner` is reassigned by `setUseRunner`,
// and a destructured copy would freeze the value at import time.
const currentMode = () => agentState.useRunner;

// Mirrors RECONNECT_DEQUEUE_DEBOUNCE_MS in the module under test.
const RECONNECT_DEQUEUE_DEBOUNCE_MS = 1000;

// Boot-time call counts, snapshotted before `vi.clearAllMocks()` erases them.
const bootCalls = { initConnection: 0, sync: 0, mode: null };

describe('subAgentSpawner — runner promotion (#4134)', () => {
  beforeAll(async () => {
    // initSpawner is memoized, so this is the one run that wires the handlers.
    await initSpawner();
    bootCalls.initConnection = vi.mocked(initCosRunnerConnection).mock.calls.length;
    bootCalls.sync = vi.mocked(syncRunnerAgents).mock.calls.length;
    bootCalls.mode = currentMode();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agentState.setUseRunner(false);
  });

  it('seeds direct mode from the boot probe but still opens the runner socket', () => {
    // The socket reconnects forever with capped backoff. Opening it only when
    // the probe succeeded is what made the demotion permanent.
    expect(bootCalls.mode).toBe(false);
    expect(bootCalls.initConnection).toBe(1);
  });

  it('does not reconcile runner agents at boot when the probe found no runner', () => {
    // With the probe false there is nothing to adopt, and /agents would fail
    // anyway — the reconciliation belongs to the promotion edge instead.
    expect(bootCalls.sync).toBe(0);
  });

  it('wires the runner event handlers in direct mode, so a promotion has somewhere to land', () => {
    // Inert while `runnerAgents` is empty — every handler keys off it — but
    // registered, so a runner that comes up later is actually listened to.
    for (const event of ['agent:output', 'agent:completed', 'agents:orphaned', 'agent:error']) {
      expect(runnerHandlers.has(event)).toBe(true);
    }
  });

  it('promotes to runner mode when the runner comes up after the server', () => {
    expect(currentMode()).toBe(false);

    runnerHandlers.get('connection:ready')();

    expect(currentMode()).toBe(true);
  });

  it('announces the promotion on the CoS log stream, not just stdout', () => {
    runnerHandlers.get('connection:ready')();

    // The disconnect warning goes through emitLog, so the resolution must too —
    // otherwise the UI shows an outage that never visibly ends.
    const promotions = vi.mocked(emitLog).mock.calls.filter(([, message]) => /promoting/.test(message));
    expect(promotions).toHaveLength(1);
    expect(promotions[0][0]).toBe('info');
  });

  it('reconciles agents a runner that was already up owns, on promotion', () => {
    runnerHandlers.get('connection:ready')();

    // Adopts only agents this process does not already own, so an agent spawned
    // DIRECTLY before the promotion keeps completing through its own close
    // handler (`isAgentOwnedLocally`, covered in agentRunnerSync.test.js).
    expect(syncRunnerAgents).toHaveBeenCalledTimes(1);
  });

  it('promotes once — a later reconnect in runner mode does not re-reconcile', () => {
    runnerHandlers.get('connection:ready')();
    runnerHandlers.get('connection:ready')();
    runnerHandlers.get('connection:ready')();

    expect(syncRunnerAgents).toHaveBeenCalledTimes(1);
  });

  it('survives a reconciliation failure without leaving the process unpromoted', async () => {
    vi.mocked(syncRunnerAgents).mockRejectedValueOnce(new Error('runner /agents 500'));

    runnerHandlers.get('connection:ready')();
    await Promise.resolve();

    // The promotion is the point; recovery is best-effort. An unguarded
    // rejection here would also crash the process — this runs on a socket
    // callback, outside any request lifecycle.
    expect(currentMode()).toBe(true);
  });

  it('resumes held tasks only after reconciliation settles', async () => {
    let finishSync;
    vi.mocked(syncRunnerAgents).mockReturnValueOnce(new Promise(resolve => { finishSync = resolve; }));
    vi.useFakeTimers();

    runnerHandlers.get('connection:ready')();
    await vi.advanceTimersByTimeAsync(RECONNECT_DEQUEUE_DEBOUNCE_MS);

    // The debounce elapsed, but the runner has not finished listing its agents:
    // dequeuing now would size capacity against a half-populated map.
    expect(cosEvents.emit).not.toHaveBeenCalledWith('cos:dequeue-requested');

    finishSync(0);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(cosEvents.emit).toHaveBeenCalledWith('cos:dequeue-requested');
  });

  it('drops an armed reconnect dequeue when the runner drops again inside the debounce window', async () => {
    vi.useFakeTimers();

    runnerHandlers.get('connection:ready')();
    runnerHandlers.get('connection:lost')();
    await vi.advanceTimersByTimeAsync(RECONNECT_DEQUEUE_DEBOUNCE_MS);
    vi.useRealTimers();

    // Otherwise the outage announces "resuming held agent tasks" and drives a
    // full dequeue cycle into a runner that is gone again.
    expect(cosEvents.emit).not.toHaveBeenCalledWith('cos:dequeue-requested');
  });

  it('keeps runner mode when the connection drops, so tasks hold instead of spawning direct', () => {
    runnerHandlers.get('connection:ready')();
    expect(currentMode()).toBe(true);

    runnerHandlers.get('connection:lost')();

    // Demoting here would flip the dispatch gate (`useRunner && !reachable`) off
    // and spawn every held task as a child of portos-server.
    expect(currentMode()).toBe(true);
  });
});
