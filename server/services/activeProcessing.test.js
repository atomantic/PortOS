import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  capability: vi.fn(), utilization: vi.fn(), jobs: vi.fn(), running: vi.fn(), models: vi.fn(), loaded: vi.fn(), tasks: vi.fn(), status: vi.fn(), agents: vi.fn(),
}));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: deps.capability, getCudaUtilization: deps.utilization }));
vi.mock('./mediaJobQueue/index.js', () => ({ listJobs: deps.jobs, getRunningJob: deps.running }));
vi.mock('./mediaJobQueue/sanitizeJob.js', () => ({ sanitizeJob: (job) => ({ id: job.id, kind: job.kind, status: job.status, params: { musicStudio: job.params.musicStudio } }) }));
vi.mock('./imageTo3d/models.js', () => ({ listModels: deps.models }));
vi.mock('./ollamaManager.js', () => ({ getLoadedModels: deps.loaded }));
vi.mock('./cos.js', () => ({ getAllTasks: deps.tasks, getStatus: deps.status, getAgents: deps.agents }));

const { getActiveProcessing } = await import('./activeProcessing.js');

describe('active processing snapshot', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
  });

  it('reports sanitized audio work, GPU utilization, and non-media extras', async () => {
    deps.capability.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', vramMib: 24000 }] });
    deps.utilization.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', utilizationPercent: 44, memoryUsedMib: 1000, memoryTotalMib: 24000 }] });
    deps.jobs.mockReturnValue([{ id: 'audio-1', kind: 'audio', status: 'running', params: { prompt: 'fake', musicStudio: { trackId: 'track-1' }, secretPath: '/private' } }]);
    deps.running.mockReturnValue({ kind: 'audio' });
    deps.models.mockResolvedValue([{ id: 'mesh-1', name: 'Fake mesh', status: 'generating' }]);
    deps.loaded.mockResolvedValue([{ id: 'model-1', name: 'Fake model' }]);
    deps.tasks.mockResolvedValue({ user: { tasks: [{ id: 'task-1', status: 'pending' }] }, cos: { tasks: [{ id: 'cos-task-1', status: 'completed' }] } });
    deps.status.mockResolvedValue({ activeAgents: 99 });
    deps.agents.mockResolvedValue([
      { id: 'agent-1', status: 'running', taskId: 'task-a' },
      { id: 'agent-2', status: 'running', taskId: 'task-b' },
    ]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.gpu).toMatchObject({ status: 'available', laneBusy: true, laneKind: 'audio' });
    expect(snapshot.gpu.gpus[0]).toMatchObject({ utilizationPercent: 44, memoryUsedMib: 1000 });
    expect(snapshot.extras.imageTo3d).toEqual([{ id: 'mesh-1', name: 'Fake mesh' }]);
    expect(snapshot.extras.ollama).toEqual([{ id: 'model-1', name: 'Fake model' }]);
    expect(snapshot.agents).toEqual({ active: 2, queued: 1 });
    expect(deps.status).not.toHaveBeenCalled();
  });

  it('preserves an absent GPU as a real negative state without probing utilization', async () => {
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.tasks.mockResolvedValue({ user: {}, cos: {} });
    deps.status.mockResolvedValue({ activeAgents: 0 });
    deps.agents.mockResolvedValue([]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.gpu).toMatchObject({ status: 'absent', laneBusy: false, laneKind: null, gpus: [] });
    expect(deps.utilization).not.toHaveBeenCalled();
  });
});

// The task record keeps its `pending` status until spawnAgentForTask flips it to
// `in_progress`, which the server does AFTER registering the agent as running.
// A snapshot taken inside that window used to report the one task as both
// queued AND active, so the widget read "1 active, 1 queued" for a single run.
describe('queued agent count', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.status.mockResolvedValue({ activeAgents: 0 });
  });

  it('does not count a pending task a running agent already holds', async () => {
    deps.tasks.mockResolvedValue({
      user: { tasks: [{ id: 'task-spawning', status: 'pending' }, { id: 'task-waiting', status: 'pending' }] },
      cos: { tasks: [] },
    });
    deps.agents.mockResolvedValue([{ id: 'agent-1', status: 'running', taskId: 'task-spawning' }]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ active: 1, queued: 1 });
  });

  it('still counts a pending task whose agent already completed', async () => {
    deps.tasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [{ id: 'cos-task-1', status: 'pending' }] } });
    deps.agents.mockResolvedValue([{ id: 'agent-1', status: 'completed', taskId: 'cos-task-1' }]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ active: 0, queued: 1 });
  });

  // A failed agent read is not an empty one. Collapsing the two would report
  // zero active agents AND still count their tasks as queued — understating both
  // numbers at once — so the failure path falls back to getStatus()'s own tally.
  it('falls back to the status tally when the agent read fails, without dropping pending tasks', async () => {
    deps.status.mockResolvedValue({ activeAgents: 3 });
    deps.tasks.mockResolvedValue({ user: { tasks: [{ id: 'task-1', status: 'pending' }] }, cos: { tasks: [] } });
    deps.agents.mockRejectedValue(new Error('state unreadable'));
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ active: 3, queued: 1 });
    expect(deps.status).toHaveBeenCalledTimes(1);
  });

  // ...and a successful read of an EMPTY list still means zero, not the fallback.
  it('reports zero active from an empty agent list without waiting for status', async () => {
    deps.status.mockImplementation(() => new Promise(() => {}));
    deps.tasks.mockResolvedValue({ user: { tasks: [{ id: 'task-1', status: 'pending' }] }, cos: { tasks: [] } });
    deps.agents.mockResolvedValue([]);
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ active: 0, queued: 1 });
    expect(deps.status).not.toHaveBeenCalled();
  });

  it('preserves pending tasks when both agent and fallback status reads fail', async () => {
    deps.tasks.mockResolvedValue({ user: { tasks: [{ id: 'task-1', status: 'pending' }] }, cos: { tasks: [] } });
    deps.agents.mockRejectedValue(new Error('state unreadable'));
    deps.status.mockRejectedValue(new Error('status unavailable'));
    const snapshot = await getActiveProcessing();
    expect(snapshot.agents).toEqual({ active: 0, queued: 1 });
    expect(deps.status).toHaveBeenCalledTimes(1);
  });
});
