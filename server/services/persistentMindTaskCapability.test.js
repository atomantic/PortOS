import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: { config: { persistentMindCapabilities: { createTasks: true } } },
  apps: [{ id: 'portos', name: 'PortOS', repoPath: '/example/portos' }],
  providers: [{
    id: 'codex', name: 'Codex', type: 'cli', enabled: true, command: 'codex',
    defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'],
  }],
  existing: null,
  addTask: vi.fn(),
  getTaskById: vi.fn(),
}));

vi.mock('./apps.js', () => ({ getActiveApps: vi.fn(async () => mocks.apps) }));
vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mocks.root) }));
vi.mock('./cosTaskStore.js', () => ({
  addTask: (...args) => mocks.addTask(...args),
  getTaskById: (...args) => mocks.getTaskById(...args),
}));
vi.mock('./providers.js', () => ({ listProviders: vi.fn(async () => mocks.providers) }));

const {
  buildPersistentMindTaskCapabilityPrompt,
  executePersistentMindTaskRequests,
  readPersistentMindTaskCatalog,
} = await import('./persistentMindTaskCapability.js');

const taskRequest = (overrides = {}) => ({
  description: 'Audit the local configuration contract',
  prompt: 'Inspect the repository, implement the bounded fix, and verify it.',
  priority: 'HIGH',
  appId: 'portos',
  providerId: 'codex',
  model: 'gpt-5',
  effort: 'high',
  prCompletion: 'review-then-merge',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root = { config: { persistentMindCapabilities: { createTasks: true } } };
  mocks.apps = [{ id: 'portos', name: 'PortOS', repoPath: '/example/portos' }];
  mocks.providers = [{
    id: 'codex', name: 'Codex', type: 'cli', enabled: true, command: 'codex',
    defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'],
  }];
  mocks.existing = null;
  mocks.getTaskById.mockImplementation(async () => mocks.existing);
  mocks.addTask.mockResolvedValue({ id: 'sys-mind-stable', status: 'pending', autoApproved: true });
});

describe('persistent mind CoS-task capability', () => {
  it('publishes only bounded app/provider/model/effort choices to the mind', async () => {
    mocks.apps.push({ id: 'no-repo', name: 'No Repository' });
    mocks.providers.push({ id: 'api-only', name: 'API Only', type: 'api', enabled: true });
    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog).toEqual({
      apps: [{ id: 'portos', name: 'PortOS' }],
      providers: [{
        id: 'codex', name: 'Codex', type: 'cli',
        models: [
          { id: 'gpt-5', efforts: expect.arrayContaining(['high']) },
          { id: 'gpt-5-mini', efforts: expect.arrayContaining(['high']) },
        ],
      }],
    });
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog });
    expect(prompt).toContain('"review-then-merge"');
    expect(prompt).toContain('"merge-on-green"');
    expect(prompt).toContain('"leave-open"');
    expect(prompt).not.toContain('command');
  });

  it('bounds a large configured catalog before it enters the reasoning prompt', () => {
    const catalog = {
      apps: Array.from({ length: 100 }, (_, index) => ({ id: `app-${index}`, name: 'A'.repeat(100) })),
      providers: Array.from({ length: 50 }, (_, providerIndex) => ({
        id: `provider-${providerIndex}`,
        name: 'P'.repeat(100),
        type: 'cli',
        models: Array.from({ length: 60 }, (_, modelIndex) => ({
          id: `model-${providerIndex}-${modelIndex}-${'m'.repeat(120)}`,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        })),
      })),
    };
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog });
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain('app-0');
    expect(prompt).toContain('provider-0');
  });

  it('queues an auto-approved isolated task with the chosen run and PR policy', async () => {
    const recordCapabilityEvent = vi.fn(async () => true);
    const results = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest()],
      turnId: 'turn-1',
      wake: { kind: 'message', message: { id: 'message-1' } },
      recordCapabilityEvent,
    });

    expect(results).toMatchObject([{ success: true, duplicate: false }]);
    expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^sys-mind-/),
      app: 'portos', provider: 'codex', model: 'gpt-5', effort: 'high',
      useWorktree: true, openPR: true, prCompletion: 'review-then-merge',
      simplify: true, approvalRequired: false,
    }), 'internal');
    expect(recordCapabilityEvent.mock.calls.map(([event]) => event.kind)).toEqual(['request', 'result']);
  });

  it('fails closed when access is revoked after inference', async () => {
    mocks.root.config.persistentMindCapabilities.createTasks = false;
    const recordCapabilityEvent = vi.fn(async () => true);
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ prCompletion: 'leave-open' })],
      turnId: 'turn-2',
      wake: { kind: 'self', id: 'wake-2' },
      recordCapabilityEvent,
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('disabled') });
    expect(mocks.addTask).not.toHaveBeenCalled();
    expect(recordCapabilityEvent).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit provider-default model choice', async () => {
    await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: '', effort: '', prCompletion: 'merge-on-green' })],
      turnId: 'turn-default-model',
      wake: { kind: 'message', message: { id: 'message-default-model' } },
    });
    const queued = mocks.addTask.mock.calls[0][0];
    expect(queued.provider).toBe('codex');
    expect(queued.model).toBeUndefined();
    expect(queued.effort).toBeUndefined();
  });

  it('rejects invented models and unsupported effort before queueing', async () => {
    const results = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'invented' }), taskRequest({ effort: 'ultra' })],
      turnId: 'turn-3',
      wake: { kind: 'message', message: { id: 'message-3' } },
    });
    expect(results[0]).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
    expect(results[1]).toMatchObject({ success: false, error: expect.stringContaining('not supported') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('rejects non-runnable app and provider choices if configuration changes after inference', async () => {
    mocks.apps = [{ id: 'portos', name: 'PortOS' }];
    mocks.providers = [{ id: 'codex', name: 'Codex API', type: 'api', enabled: true }];
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest()],
      turnId: 'turn-unrunnable',
      wake: { kind: 'message', message: { id: 'message-unrunnable' } },
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('repository') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('allows only the provider default when no concrete models are configured', async () => {
    mocks.providers = [{
      id: 'codex', name: 'Codex', type: 'cli', enabled: true, command: 'codex',
      defaultModel: 'codex-configured-default', models: [],
    }];
    const results = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'invented' }), taskRequest({ model: '', effort: '' })],
      turnId: 'turn-empty-catalog',
      wake: { kind: 'message', message: { id: 'message-empty-catalog' } },
    });
    expect(results[0]).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
    expect(results[1]).toMatchObject({ success: true });
    expect(mocks.addTask).toHaveBeenCalledTimes(1);
  });

  it('reuses the stable task id when a wake is replayed after queueing', async () => {
    mocks.existing = { id: 'sys-mind-existing', status: 'pending', taskType: 'internal' };
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ prCompletion: 'merge-on-green' })],
      turnId: 'turn-retry',
      wake: { kind: 'message', message: { id: 'message-stable' } },
    });
    expect(result).toMatchObject({ success: true, duplicate: true, task: { id: 'sys-mind-existing' } });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('binds replay ids to request content rather than array position', async () => {
    const first = taskRequest({ description: 'First task' });
    const second = taskRequest({ description: 'Second task' });
    const wake = { kind: 'message', message: { id: 'message-reordered' } };
    const firstEvents = vi.fn(async () => true);
    const secondEvents = vi.fn(async () => true);

    await executePersistentMindTaskRequests({ taskRequests: [first, second], turnId: 'turn-a', wake, recordCapabilityEvent: firstEvents });
    await executePersistentMindTaskRequests({ taskRequests: [second, first], turnId: 'turn-b', wake, recordCapabilityEvent: secondEvents });

    const taskIds = mocks.addTask.mock.calls.map(([task]) => task.id);
    expect(taskIds[0]).toBe(taskIds[3]);
    expect(taskIds[1]).toBe(taskIds[2]);
    expect(taskIds[0]).not.toBe(taskIds[1]);
    const requestEventIds = (events) => events.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'request')
      .map((event) => event.id)
      .sort();
    expect(requestEventIds(firstEvents)).toEqual(requestEventIds(secondEvents));
  });
});
