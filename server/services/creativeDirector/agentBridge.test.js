import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
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
});
