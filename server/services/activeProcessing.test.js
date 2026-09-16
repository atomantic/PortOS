import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  capability: vi.fn(), utilization: vi.fn(), jobs: vi.fn(), running: vi.fn(), models: vi.fn(), loaded: vi.fn(), tasks: vi.fn(), status: vi.fn(), agents: vi.fn(),
  mind: vi.fn(), operations: vi.fn(), updating: vi.fn(),
}));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: deps.capability, getCudaUtilization: deps.utilization }));
vi.mock('./mediaJobQueue/index.js', () => ({ listJobs: deps.jobs, getRunningJob: deps.running }));
vi.mock('./mediaJobQueue/sanitizeJob.js', () => ({ sanitizeJob: (job) => ({ id: job.id, kind: job.kind, status: job.status, params: { musicStudio: job.params.musicStudio } }) }));
vi.mock('./imageTo3d/models.js', () => ({ listGeneratingModelSummaries: deps.models }));
vi.mock('./ollamaManager.js', () => ({ getLoadedModels: deps.loaded }));
vi.mock('./cos.js', () => ({ getPendingTaskIds: deps.tasks, getStatus: deps.status, getAgents: deps.agents }));
vi.mock('./cosState.js', () => ({ readPersistentMindStateForSafetyCheck: deps.mind }));
vi.mock('./appOperations.js', () => ({ listActiveAppOperations: deps.operations }));
vi.mock('./updateChecker.js', () => ({ isUpdateInProgress: deps.updating }));

const { getActiveProcessing } = await import('./activeProcessing.js');

describe('active processing snapshot', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
    deps.mind.mockResolvedValue({ trusted: true, persistentMind: { enabled: true, started: true, status: 'idle', queuedMessages: [], activeTurn: null } });
    deps.operations.mockReturnValue([]);
    deps.updating.mockReturnValue(false);
  });

  it('reports sanitized audio work, GPU utilization, and non-media extras', async () => {
    deps.capability.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', vramMib: 24000 }] });
    deps.utilization.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', utilizationPercent: 44, memoryUsedMib: 1000, memoryTotalMib: 24000 }] });
    deps.jobs.mockReturnValue([{ id: 'audio-1', kind: 'audio', status: 'running', params: { prompt: 'fake', musicStudio: { trackId: 'track-1' }, secretPath: '/private' } }]);
    deps.running.mockReturnValue({ kind: 'audio' });
    deps.models.mockResolvedValue([{ id: 'mesh-1', name: 'Fake mesh' }, { id: 'mesh-2', name: '' }]);
    deps.loaded.mockResolvedValue([{ id: 'model-1', name: 'Fake model' }]);
    deps.tasks.mockResolvedValue(['task-1']);
    deps.status.mockResolvedValue({ activeAgents: 99 });
    deps.agents.mockResolvedValue([
      { id: 'agent-1', status: 'running', taskId: 'task-a' },
      { id: 'agent-2', status: 'running', taskId: 'task-b' },
    ]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.gpu).toMatchObject({ status: 'available', laneBusy: true, laneKind: 'audio' });
    expect(snapshot.gpu.gpus[0]).toMatchObject({ utilizationPercent: 44, memoryUsedMib: 1000 });
    expect(snapshot.extras.imageTo3d).toEqual([{ id: 'mesh-1', name: 'Fake mesh' }, { id: 'mesh-2', name: 'mesh-2' }]);
    expect(snapshot.extras.ollama).toEqual([{ id: 'model-1', name: 'Fake model' }]);
    expect(snapshot.agents).toEqual({ trusted: true, active: 2, queued: 1 });
    expect(deps.status).not.toHaveBeenCalled();
  });

  it('preserves an absent GPU as a real negative state without probing utilization', async () => {
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.tasks.mockResolvedValue([]);
    deps.status.mockResolvedValue({ activeAgents: 0 });
    deps.agents.mockResolvedValue([]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.gpu).toMatchObject({ status: 'absent', laneBusy: false, laneKind: null, gpus: [] });
    expect(snapshot.extras.imageTo3d).toEqual([]);
    deps.models.mockRejectedValueOnce(new Error('store unavailable'));
    expect((await getActiveProcessing()).extras.imageTo3d).toEqual([]);
    expect(deps.utilization).not.toHaveBeenCalled();
  });
});

// The snapshot is what the dashboard renders AND what the unattended updater
// refuses on, so the Persistent Mind slice must say whether the mind is busy
// without saying anything about what it is busy WITH.
describe('persistent mind and idle verdict', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
    deps.operations.mockReturnValue([]);
    deps.updating.mockReturnValue(false);
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.tasks.mockResolvedValue([]);
    deps.agents.mockResolvedValue([]);
    deps.status.mockResolvedValue({ activeAgents: 0 });
  });

  it('reports an active turn as thinking, carrying counts but no message content', async () => {
    deps.mind.mockResolvedValue({
      trusted: true,
      persistentMind: {
        enabled: true, started: true, status: 'thinking',
        activeTurn: { id: 'turn-1', startedAt: '2026-01-01T00:00:00.000Z', wake: { kind: 'message', message: { id: 'm1', text: 'private thought' } } },
        queuedMessages: [{ id: 'm2', text: 'another private message' }],
      },
    });
    const snapshot = await getActiveProcessing();
    expect(snapshot.mind).toEqual({
      trusted: true, enabled: true, started: true, status: 'thinking',
      thinking: true, thinkingSince: '2026-01-01T00:00:00.000Z', queued: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain('private');
    expect(snapshot.activity.idle).toBe(false);
  });

  it('reports an idle install as idle, with no blockers', async () => {
    deps.mind.mockResolvedValue({ trusted: true, persistentMind: { enabled: true, started: true, status: 'waiting', activeTurn: null, queuedMessages: [] } });
    const snapshot = await getActiveProcessing();
    expect(snapshot.activity).toMatchObject({ idle: true, blockers: [] });
  });

  // An unreadable mind state must not read as an idle one — the update path
  // refuses on exactly that condition.
  it('does not read an unreadable mind state as idle', async () => {
    deps.mind.mockRejectedValue(new Error('state unreadable'));
    const snapshot = await getActiveProcessing();
    expect(snapshot.mind.trusted).toBe(false);
    expect(snapshot.activity.idle).toBe(false);
  });

  it('counts a live app operation as activity', async () => {
    deps.mind.mockResolvedValue({ trusted: true, persistentMind: { enabled: false, started: false, status: 'disabled', activeTurn: null, queuedMessages: [] } });
    deps.operations.mockReturnValue([{ appId: 'example', appName: 'Example App', type: 'update', startedAt: 1 }]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.activity.idle).toBe(false);
    expect(snapshot.activity.blockers.map(b => b.kind)).toContain('app-operations');
  });
});

// The task record keeps its `pending` status until spawnAgentForTask flips it to
// `in_progress`, which the server does AFTER registering the agent as running.
// A snapshot taken inside that window used to report the one task as both
// queued AND active, so the widget read "1 active, 1 queued" for a single run.
describe('queued agent count', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
    deps.mind.mockResolvedValue({ trusted: true, persistentMind: { enabled: true, started: true, status: 'idle', queuedMessages: [], activeTurn: null } });
    deps.operations.mockReturnValue([]);
    deps.updating.mockReturnValue(false);
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.status.mockResolvedValue({ activeAgents: 0 });
  });

  it('does not count a pending task a running agent already holds', async () => {
    deps.tasks.mockResolvedValue(['task-spawning', 'task-waiting']);
    deps.agents.mockResolvedValue([{ id: 'agent-1', status: 'running', taskId: 'task-spawning' }]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ trusted: true, active: 1, queued: 1 });
  });

  it('still counts a pending task whose agent already completed', async () => {
    deps.tasks.mockResolvedValue(['cos-task-1']);
    deps.agents.mockResolvedValue([{ id: 'agent-1', status: 'completed', taskId: 'cos-task-1' }]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ trusted: true, active: 0, queued: 1 });
  });

  // A failed agent read is not an empty one. Collapsing the two would report
  // zero active agents AND still count their tasks as queued — understating both
  // numbers at once — so the failure path falls back to getStatus()'s own tally.
  it('falls back to the status tally when the agent read fails, without dropping pending tasks', async () => {
    deps.status.mockResolvedValue({ activeAgents: 3 });
    deps.tasks.mockResolvedValue(['task-1']);
    deps.agents.mockRejectedValue(new Error('state unreadable'));
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ trusted: true, active: 3, queued: 1 });
    expect(deps.status).toHaveBeenCalledTimes(1);
  });

  // ...and a successful read of an EMPTY list still means zero, not the fallback.
  it('reports zero active from an empty agent list without waiting for status', async () => {
    deps.status.mockImplementation(() => new Promise(() => {}));
    deps.tasks.mockResolvedValue(['task-1']);
    deps.agents.mockResolvedValue([]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ trusted: true, active: 0, queued: 1 });
    expect(deps.status).not.toHaveBeenCalled();
  });

  // Both reads failing means "could not count", not "nothing is running" — and
  // zero active agents is exactly the value that unlocks an unattended restart.
  // The pending-task list is a separate read, so its count survives.
  it('marks the slice untrusted when both agent reads fail, and still blocks idle', async () => {
    deps.tasks.mockResolvedValue(['task-1']);
    deps.agents.mockRejectedValue(new Error('state unreadable'));
    deps.status.mockRejectedValue(new Error('status unavailable'));
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ trusted: false, active: 0, queued: 1 });
    expect(deps.status).toHaveBeenCalledTimes(1);
    expect(snapshot.activity.idle).toBe(false);
    expect(snapshot.activity.blockers.map(b => b.kind)).toContain('agents-unreadable');
  });
});
