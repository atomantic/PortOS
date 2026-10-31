/**
 * #11860 — the CoS daemon start/stop lifecycle. `start()` holds for the Creative
 * Director recovery gate (up to 60 s) after setting the running flag, so a Stop
 * landing in that window used to tear down timers that did not exist yet and
 * then watch the resumed boot arm every interval — including the PR merge sweep.
 *
 * Drives the real start()/stop() with the boot dependencies doubled and the
 * event scheduler replaced by a registry, so "what is still scheduled" is
 * observable. Lives in its own file because the module-wide mocks would
 * replace helpers cos.test.js exercises for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scheduled = new Set();
const handlers = new Map();
vi.mock('./eventScheduler.js', async (importOriginal) => ({
  ...(await importOriginal()),
  schedule: vi.fn(({ id, handler }) => { scheduled.add(id); handlers.set(id, handler); return id; }),
  cancel: vi.fn((id) => scheduled.delete(id)),
}));

const completionWake = vi.hoisted(() => ({ held: false, run: vi.fn(async () => ({ checked: 3 })) }));
vi.mock('../lib/maintenanceAdmission.js', async original => {
  const actual = await original();
  return { ...actual, maintenance: { ...actual.maintenance, held: () => completionWake.held } };
});
vi.mock('./agentRepoStateVerification.js', () => ({
  sweepRepoStateVerifications: (...args) => completionWake.run(...args),
  resumeDeferredRepoStateVerifications: async blocked => { const reason = await blocked(); return reason ? { checked: 0, skipReason: reason } : completionWake.run(); },
  bindCompletionRetirementEvents: () => () => {},
}));
let persisted = { running: false, paused: false, agents: {}, config: { healthCheckIntervalMs: 900000 } };
vi.mock('./cosState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureDirectories: vi.fn(async () => {}),
  loadState: vi.fn(async () => structuredClone(persisted)),
  saveState: vi.fn(async (s) => { persisted = structuredClone(s); }),
  withStateLock: vi.fn(async (fn) => fn()),
}));

const boot = { cleanupOrphanedAgents: vi.fn(async () => 0) };
vi.mock('./agentManagement.js', () => ({
  cleanupOrphanedAgents: (...args) => boot.cleanupOrphanedAgents(...args),
  handleOrphanedTask: vi.fn(async () => {}),
}));

let releaseRecovery;
vi.mock('./creativeDirector/recovery.js', () => ({
  get cdRecoveryDone() {
    return new Promise((resolve) => { releaseRecovery = resolve; });
  },
}));

vi.mock('./cosTaskStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllTasks: vi.fn(async () => ({ user: { tasks: [], grouped: {} }, cos: { tasks: [], grouped: {} } })),
  getCosTasks: vi.fn(async () => ({ tasks: [] })),
  readPendingTaskIds: vi.fn(async () => []),
}));
vi.mock('./providers.js', () => ({ getActiveProvider: vi.fn(async () => null) }));
vi.mock('./cosAgentIndex.js', async importOriginal => ({ ...(await importOriginal()), loadAgentIndex: vi.fn(async () => new Map()) }));
vi.mock('./instanceIdentity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureInstanceId: vi.fn(async () => 'instance-test'),
}));
vi.mock('./appActivity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  clearStaleActiveAgents: vi.fn(async () => ({ cleared: [] })),
}));
vi.mock('./cosAgentArchive.js', async (importOriginal) => ({
  ...(await importOriginal()),
  archiveStaleAgents: vi.fn(async () => ({ archived: 0 })),
}));
vi.mock('./cosJobScheduler.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobSchedules: vi.fn(async () => { scheduled.add('job:test'); }),
  unregisterJobSchedules: vi.fn(async () => { scheduled.delete('job:test'); }),
  scheduleNextImprovementCheck: vi.fn(async () => { scheduled.add('cos-improvement-check'); }),
}));
vi.mock('./cosTaskGenerator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  evaluateTasks: vi.fn(async () => {}),
}));
vi.mock('./cosHealthMonitor.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runHealthCheck: vi.fn(async () => {}),
}));
vi.mock('./persistentMindAdapter.js', () => ({ createPersistentMindTurnAdapter: () => ({}) }));
vi.mock('./persistentMindSupervisor.js', async (importOriginal) => ({
  ...(await importOriginal()),
  initializePersistentMindSupervisor: vi.fn(async () => {}),
  shutdownPersistentMindSupervisor: vi.fn(async () => {}),
  registerPersistentMindTurnAdapter: vi.fn(async () => {}),
}));
// The handoff follow-up poll lives in prWatcher; the daemon arms its gate and
// cancels it, so "armed" here is the registered gate.
const handoffFollowUp = vi.hoisted(() => ({ gate: null }));
vi.mock('./prWatcher.js', () => ({
  PENDING_MERGE_SWEEP_INTERVAL_MS: 1800000,
  sweepPendingMergePrs: vi.fn(async () => null),
  setHandoffFollowUpGate: (gate) => { handoffFollowUp.gate = gate; },
  cancelHandoffFollowUps: () => { handoffFollowUp.gate = null; },
}));

const { start, stop, getStatus, resumeDeferredCompletions } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { isDaemonRunning } = await import('./cosState.js');

const cosEventIds = () => [...scheduled].filter(id => id.startsWith('cos-') || id.startsWith('job:'));
const waitFor = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setImmediate(r));
  expect(predicate()).toBe(true);
};

let statuses;
const onStatus = (s) => statuses.push(s);

beforeEach(() => {
  // Fake only setTimeout: boot's post-start improvement queue (30 s) and the
  // recovery ceiling (60 s) would otherwise keep the worker alive past the run.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  completionWake.held = false; completionWake.run.mockClear();
  statuses = [];
  releaseRecovery = null;
  cosEvents.on('status', onStatus);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  cosEvents.off('status', onStatus);
  if (isDaemonRunning()) await stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  boot.cleanupOrphanedAgents = vi.fn(async () => 0);
});

describe('CoS daemon start/stop lifecycle (#11860)', () => {
  it('replays persisted completions on startup and restart without advancing the fallback timer', async () => {
    persisted = { ...persisted, paused: false, config: { ...persisted.config, domainAutonomy: { cos: 'execute' } } };
    for (let boot = 1; boot <= 2; boot++) {
      const starting = start();
      await waitFor(() => typeof releaseRecovery === 'function');
      releaseRecovery(); await starting;
      await waitFor(() => completionWake.run.mock.calls.length === boot);
      await stop(); releaseRecovery = null;
    }
  });

  it('does not recover through maintenance, pause, stopped or non-execute policy boundaries', async () => {
    persisted = { ...persisted, paused: false, config: { ...persisted.config, domainAutonomy: { cos: 'execute' } } };
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    releaseRecovery(); await starting;
    await waitFor(() => completionWake.run.mock.calls.length === 1);
    completionWake.run.mockClear();
    completionWake.held = true;
    expect(await resumeDeferredCompletions()).toMatchObject({ checked: 0, skipReason: 'maintenance-held' });
    completionWake.held = false; persisted.paused = true;
    expect(await resumeDeferredCompletions()).toMatchObject({ checked: 0, skipReason: 'daemon paused' });
    persisted.paused = false;
    for (const mode of ['off', 'dry-run']) {
      persisted.config.domainAutonomy.cos = mode;
      expect(await resumeDeferredCompletions()).toMatchObject({ checked: 0, skipReason: 'CoS auto-run is not set to execute' });
    }
    await stop();
    expect(await resumeDeferredCompletions()).toMatchObject({ checked: 0, skipReason: 'daemon-stopped' });
    expect(completionWake.run).not.toHaveBeenCalled();
  });

  it('exposes recovery gates and the actual scheduled sweep time without promising a job completion time', async () => {
    persisted = { ...persisted, paused: false, stats: { tasksCompleted: 0 }, config: { ...persisted.config, domainAutonomy: { cos: 'execute' } } };
    expect((await getStatus()).completionRecovery).toMatchObject({ blockedReason: 'CoS is stopped', nextRunAt: null, batchSize: 10 });
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    releaseRecovery(); await starting;
    // This suite's scheduler registry deliberately has no real timer.
    expect((await getStatus()).completionRecovery.blockedReason).toBe('Completion recovery is not scheduled');
    const scheduler = await import('./eventScheduler.js');
    vi.spyOn(scheduler, 'getEvent').mockReturnValue({ active: true, nextRunAt: 1800000, intervalMs: 1800000 });
    expect((await getStatus()).completionRecovery).toEqual({ blockedReason: null, nextRunAt: 1800000, intervalMs: 1800000, batchSize: 10 });
    persisted.paused = true;
    expect((await getStatus()).completionRecovery).toMatchObject({ blockedReason: 'CoS is paused', nextRunAt: null });
    persisted.paused = false;
    persisted.config.domainAutonomy.cos = 'dry-run';
    expect((await getStatus()).completionRecovery).toMatchObject({ blockedReason: 'CoS auto-run must be in Execute mode', nextRunAt: null });
  });
  it('a Stop issued while start() is mid-boot leaves no CoS timer armed', async () => {
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    expect(isDaemonRunning()).toBe(true);

    const stopping = stop();
    releaseRecovery();
    await expect(starting).resolves.toEqual({ success: true });
    await expect(stopping).resolves.toEqual({ success: true });

    expect(cosEventIds()).toEqual([]);
    expect(handoffFollowUp.gate).toBe(null);
    expect(isDaemonRunning()).toBe(false);
    expect(persisted.running).toBe(false);
    expect(statuses.at(-1)).toEqual({ running: false });
  });

  it('a second start() while the daemon runs is refused at info, not reported as a fault', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    releaseRecovery();
    await starting;

    await expect(start()).resolves.toEqual({ success: false, error: 'Already running' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('CoS already running'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('CoS already running'));
  });

  it('the handoff follow-up poll shares the pending-merge gate and is cancelled on stop', async () => {
    persisted = { ...persisted, paused: false, config: { ...persisted.config, domainAutonomy: { cos: 'execute' } } };
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    releaseRecovery();
    await starting;
    expect(await handoffFollowUp.gate()).toBe(null);
    persisted = { ...persisted, paused: true };
    expect(await handoffFollowUp.gate()).toBe('daemon paused');

    await stop();
    expect(handoffFollowUp.gate).toBe(null);
  });

  it('a boot step that throws rolls the daemon back so the next start() succeeds', async () => {
    boot.cleanupOrphanedAgents = vi.fn(async () => { throw new Error('agent state unreadable'); });
    await expect(start()).rejects.toThrow('agent state unreadable');
    expect(isDaemonRunning()).toBe(false);
    expect(persisted.running).toBe(false);
    expect(cosEventIds()).toEqual([]);

    boot.cleanupOrphanedAgents = vi.fn(async () => 0);
    const restarting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    releaseRecovery();
    await expect(restarting).resolves.toEqual({ success: true });
    expect(isDaemonRunning()).toBe(true);
    expect(cosEventIds()).toEqual(expect.arrayContaining(['cos-health-check', 'cos-pending-merge-sweep']));
  });
});
