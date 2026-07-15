import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  emit: vi.fn(),
  buildTreatmentPrompt: vi.fn(),
  buildEvaluatePrompt: vi.fn(),
  buildPlanPrompt: vi.fn(),
  getToolSpecs: vi.fn(),
  getSettings: vi.fn(),
  recordRun: vi.fn(),
}));

vi.mock('../cos.js', () => ({
  addTask: mocks.addTask,
  updateTask: mocks.updateTask,
  cosEvents: { emit: mocks.emit },
}));
vi.mock('../../lib/creativeDirectorPrompts.js', () => ({
  buildTreatmentPrompt: mocks.buildTreatmentPrompt,
  buildEvaluatePrompt: mocks.buildEvaluatePrompt,
  buildPlanPrompt: mocks.buildPlanPrompt,
}));
vi.mock('../creative/toolRegistry.js', () => ({ getToolSpecs: mocks.getToolSpecs }));
vi.mock('../settings.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('./local.js', () => ({ recordRun: mocks.recordRun }));

const { enqueueTreatmentTask, enqueuePlanTask } = await import('./agentBridge.js');

const project = { id: 'cd-1', name: 'Test project', treatment: { scenes: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildTreatmentPrompt.mockResolvedValue('treatment context');
  mocks.buildPlanPrompt.mockResolvedValue('plan context');
  mocks.getToolSpecs.mockReturnValue([]);
  mocks.recordRun.mockResolvedValue();
  mocks.addTask.mockResolvedValue();
  mocks.getSettings.mockResolvedValue({});
});

describe('Creative Director agent bridge model assignments', () => {
  it('pins the configured treatment provider and model on its CoS task', async () => {
    mocks.getSettings.mockResolvedValue({
      creativeDirector: { treatment: { providerId: 'local-agent', model: 'qwen3' } },
    });

    await enqueueTreatmentTask(project);

    const [task] = mocks.addTask.mock.calls[0];
    expect(task.metadata).toMatchObject({
      provider: 'local-agent',
      providerId: 'local-agent',
      model: 'qwen3',
      context: 'treatment context',
    });
  });

  it('leaves planning on the system default when no assignment is saved', async () => {
    await enqueuePlanTask(project);

    const [task] = mocks.addTask.mock.calls[0];
    expect(task.metadata).not.toHaveProperty('provider');
    expect(task.metadata).not.toHaveProperty('model');
  });

  it('prefers the project-level override over the global assignment', async () => {
    mocks.getSettings.mockResolvedValue({
      creativeDirector: { treatment: { providerId: 'global-agent', model: 'global-model' } },
    });

    await enqueueTreatmentTask({
      ...project,
      modelOverrides: { treatment: { providerId: 'project-agent', model: 'project-model' } },
    });

    const [task] = mocks.addTask.mock.calls[0];
    expect(task.metadata).toMatchObject({
      provider: 'project-agent',
      providerId: 'project-agent',
      model: 'project-model',
    });
  });

  it('inherits the global assignment when the project override omits a provider', async () => {
    mocks.getSettings.mockResolvedValue({
      creativeDirector: { plan: { providerId: 'global-agent', model: 'global-model' } },
    });

    // A model-only override can't resolve (no provider) → inherit the global pin.
    await enqueuePlanTask({ ...project, modelOverrides: { plan: { model: 'stray-model' } } });

    const [task] = mocks.addTask.mock.calls[0];
    expect(task.metadata).toMatchObject({
      provider: 'global-agent',
      providerId: 'global-agent',
      model: 'global-model',
    });
  });
});

describe('persistAndEmit duplicate handling (#2614 — addTask dedup also matches blocked tasks)', () => {
  it('revives a blocked duplicate instead of emitting task:ready for an unpersisted record', async () => {
    // CD descriptions are deterministic per project+kind, so a re-trigger after
    // a failure collides with the blocked twin. The enqueue must revive that
    // task (status flip clears blocked metadata server-side) and emit
    // task:ready with the EXISTING id — never with the never-persisted one.
    mocks.addTask.mockResolvedValue({
      id: 'sys-cd-old',
      status: 'blocked',
      duplicate: true,
      metadata: { blockedCategory: 'max-retries', creativeDirector: { projectId: 'cd-1' } }
    });

    const result = await enqueueTreatmentTask(project);

    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    const [taskId, updates, group] = mocks.updateTask.mock.calls[0];
    expect(taskId).toBe('sys-cd-old');
    expect(updates.status).toBe('pending');
    expect(updates.metadata.creativeDirector.projectId).toBe('cd-1');
    expect(group).toBe('internal');
    // task:ready and the run record both reference the revived (existing) id.
    expect(result.id).toBe('sys-cd-old');
    const emitted = mocks.emit.mock.calls.find(([name]) => name === 'task:ready');
    expect(emitted[1].id).toBe('sys-cd-old');
    expect(mocks.recordRun.mock.calls[0][1].taskId).toBe('sys-cd-old');
  });

  it('does not spawn a second agent or record a run for a pending duplicate', async () => {
    const existing = { id: 'sys-cd-live', status: 'pending', duplicate: true, metadata: { creativeDirector: { projectId: 'cd-1' } } };
    mocks.addTask.mockResolvedValue(existing);

    const result = await enqueueTreatmentTask(project);

    expect(mocks.updateTask).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.recordRun).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('never revives or adopts a duplicate belonging to a DIFFERENT project', async () => {
    const foreign = { id: 'sys-cd-other', status: 'blocked', duplicate: true, metadata: { creativeDirector: { projectId: 'cd-other' } } };
    mocks.addTask.mockResolvedValue(foreign);

    const result = await enqueueTreatmentTask(project);

    expect(mocks.updateTask).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(result).toBe(foreign);
  });

  it('embeds a per-project discriminator in the task description', async () => {
    // Two projects sharing a name must not dedup against each other: CD tasks
    // carry no metadata.app, so the first line is the whole dedup key.
    await enqueueTreatmentTask(project);
    await enqueueTreatmentTask({ ...project, id: 'cd-2222' });
    const [taskA] = mocks.addTask.mock.calls[0];
    const [taskB] = mocks.addTask.mock.calls[1];
    expect(taskA.description).toContain('[cd:cd-1]');
    expect(taskB.description).toContain('[cd:cd-2222]');
    expect(taskA.description).not.toBe(taskB.description);
  });
});
