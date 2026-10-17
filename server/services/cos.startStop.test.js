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
vi.mock('./eventScheduler.js', async (importOriginal) => ({
  ...(await importOriginal()),
  schedule: vi.fn(({ id }) => { scheduled.add(id); return id; }),
  cancel: vi.fn((id) => scheduled.delete(id)),
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
  getAllTasks: vi.fn(async () => ({ user: { tasks: [] }, cos: { tasks: [] } })),
  getCosTasks: vi.fn(async () => ({ tasks: [] })),
}));
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
vi.mock('./prWatcher.js', () => ({
  PENDING_MERGE_SWEEP_INTERVAL_MS: 1800000,
  sweepPendingMergePrs: vi.fn(async () => null),
}));

const { start, stop } = await import('./cos.js');
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
  it('a Stop issued while start() is mid-boot leaves no CoS timer armed', async () => {
    const starting = start();
    await waitFor(() => typeof releaseRecovery === 'function');
    expect(isDaemonRunning()).toBe(true);

    const stopping = stop();
    releaseRecovery();
    await expect(starting).resolves.toEqual({ success: true });
    await expect(stopping).resolves.toEqual({ success: true });

    expect(cosEventIds()).toEqual([]);
    expect(isDaemonRunning()).toBe(false);
    expect(persisted.running).toBe(false);
    expect(statuses.at(-1)).toEqual({ running: false });
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
