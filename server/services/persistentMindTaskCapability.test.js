import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: { config: { persistentMindCapabilities: { createTasks: true } } },
  apps: [{ id: 'portos', name: 'PortOS', repoPath: '/example/portos' }],
  providers: [{
    id: 'codex', name: 'Codex', type: 'cli', enabled: true, command: 'codex',
    defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  }],
  existing: null,
  cosTasks: [],
  addTask: vi.fn(),
  getTaskById: vi.fn(),
  getAppWorkTracker: vi.fn(),
  resolveAppWorkTracker: vi.fn(),
  getProviderPrerequisiteReadinessMap: vi.fn(),
  listManagedBackendModels: vi.fn(),
  workspacePreflight: vi.fn(),
  assessWorkspaceReadiness: vi.fn(),
}));

vi.mock('./apps.js', () => ({
  getActiveApps: vi.fn(async () => mocks.apps),
  getAppWorkTracker: (...args) => mocks.getAppWorkTracker(...args),
}));
vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mocks.root) }));
vi.mock('./cosTaskStore.js', () => ({
  addTask: (...args) => mocks.addTask(...args),
  firstLine: (value) => (value || '').split('\n').map((line) => line.trim()).find(Boolean) || '',
  getCosTasks: vi.fn(async () => ({ tasks: mocks.cosTasks })),
  getTaskById: (...args) => mocks.getTaskById(...args),
}));
vi.mock('./providers.js', () => ({ listProviders: vi.fn(async () => mocks.providers) }));
vi.mock('./localLlm.js', () => ({
  listManagedBackendModels: (...args) => mocks.listManagedBackendModels(...args),
}));
vi.mock('./providerPrerequisites.js', () => ({
  getProviderPrerequisiteReadinessMap: (...args) => mocks.getProviderPrerequisiteReadinessMap(...args),
}));
vi.mock('../lib/workTracker.js', () => ({
  resolveAppWorkTracker: (...args) => mocks.resolveAppWorkTracker(...args),
}));
vi.mock('./persistentMindWorkspacePreflight.js', () => ({
  readPersistentMindWorkspacePreflight: (...args) => mocks.workspacePreflight(...args),
  assessPersistentMindWorkspaceReadiness: (...args) => mocks.assessWorkspaceReadiness(...args),
}));

const { PORTOS_APP_ID } = await import('../lib/appIdentity.js');

const {
  buildPersistentMindTaskCapabilityPrompt,
  executePersistentMindTaskRequests,
  readPersistentMindTaskCatalog,
  readPersistentMindTaskInventory,
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
    defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  }];
  mocks.existing = null;
  mocks.cosTasks = [];
  mocks.getAppWorkTracker.mockResolvedValue({ resolved: 'plan' });
  mocks.resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan' });
  mocks.getTaskById.mockImplementation(async () => mocks.existing);
  mocks.addTask.mockResolvedValue({ id: 'sys-mind-stable', status: 'pending', autoApproved: true });
  mocks.listManagedBackendModels.mockResolvedValue({ models: null, error: 'no daemon in tests' });
  mocks.getProviderPrerequisiteReadinessMap.mockImplementation((providers) => Object.fromEntries(
    providers.map((provider) => [provider.id, { status: 'ready', reasonCodes: [] }]),
  ));
  mocks.workspacePreflight.mockResolvedValue({ readiness: 'ready', warnings: [] });
  mocks.assessWorkspaceReadiness.mockImplementation((preflight, requiredValidation) => ({
    readiness: preflight.readiness,
    requiredValidation: requiredValidation || [],
    blockers: [],
    warnings: preflight.warnings,
  }));
});

describe('persistent mind CoS-task capability', () => {
  it('publishes only bounded app/provider/model/effort choices to the mind', async () => {
    mocks.apps.push({ id: 'no-repo', name: 'No Repository' });
    mocks.providers.push({ id: 'api-only', name: 'API Only', type: 'api', enabled: true });
    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog).toEqual({
      apps: [{ id: 'portos', name: 'PortOS', planOnly: false }],
      providers: [{
        id: 'codex', name: 'Codex', type: 'cli',
        models: [
          { id: 'gpt-5', efforts: expect.arrayContaining(['high']) },
          { id: 'gpt-5-mini', efforts: expect.arrayContaining(['high']) },
          { id: 'gpt-5.6-sol', efforts: expect.arrayContaining(['high', 'ultra']) },
          { id: 'gpt-5.6-luna', efforts: expect.not.arrayContaining(['ultra']) },
        ],
      }],
      providerReadiness: {
        blockedCount: 0,
        blockedReasonCodes: [],
        unknownCount: 0,
        unknownReasonCodes: [],
      },
    });
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog });
    expect(prompt).toContain('"review-then-merge"');
    expect(prompt).toContain('"merge-on-green"');
    expect(prompt).toContain('"leave-open"');
    expect(prompt).toContain('Plan & File Issue');
    expect(prompt).toContain('planOnly');
    expect(prompt).not.toContain('command');
  });

  it('flags only the PortOS baseline app and tells the mind to route by owning repo', async () => {
    mocks.apps = [
      { id: PORTOS_APP_ID, name: 'PortOS', repoPath: '/example/portos' },
      { id: 'managed-app', name: 'Managed App', repoPath: '/example/managed' },
    ];
    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog.apps).toEqual([
      { id: PORTOS_APP_ID, name: 'PortOS', planOnly: false, self: true },
      { id: 'managed-app', name: 'Managed App', planOnly: false },
    ]);
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog });
    expect(prompt).toContain('pick the repository that will hold the change');
    expect(prompt).toContain("marked 'self: true'");
  });

  it('publishes only allowlisted task models and rejects a model outside the policy', async () => {
    mocks.root.config.persistentMindCapabilities.taskModelAllowlist = [
      { providerId: 'codex', model: 'gpt-5-mini' },
    ];
    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog.providers).toEqual([expect.objectContaining({
      id: 'codex',
      models: [{ id: 'gpt-5-mini', efforts: expect.any(Array) }],
    })]);

    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'gpt-5' })],
      turnId: 'turn-model-policy',
      wake: { kind: 'message', message: { id: 'message-model-policy' } },
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not allowed') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('allows a configured pair after the policy is narrowed', async () => {
    mocks.root.config.persistentMindCapabilities.taskModelAllowlist = [
      { providerId: 'codex', model: 'gpt-5-mini' },
    ];
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'gpt-5-mini' })],
      turnId: 'turn-model-policy-allowed',
      wake: { kind: 'message', message: { id: 'message-model-policy-allowed' } },
    });
    expect(result).toMatchObject({ success: true });
    expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5-mini' }), 'internal');
  });

  // A local provider's `models` array is a cached snapshot; the daemon on this
  // machine is the authority, and every other model picker already offers what
  // it reports. Building this catalog from the record rejects a model the user
  // pulled after the record was last refreshed, as "not configured".
  it('sources a local-runtime provider\'s models from the daemon, not its cached list', async () => {
    mocks.providers = [{
      id: 'grok-ollama', name: 'Grok (Ollama)', type: 'cli', enabled: true, command: 'grok',
      ollamaBacked: true, models: ['qwen3-coder:30b'], defaultModel: 'qwen3-coder:30b',
    }];
    mocks.listManagedBackendModels.mockResolvedValue({
      models: [{ id: 'qwen3-coder:30b' }, { id: 'gemma3:27b' }], error: null,
    });

    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog.providers[0].models.map((model) => model.id))
      .toEqual(['qwen3-coder:30b', 'gemma3:27b']);
    expect(mocks.listManagedBackendModels).toHaveBeenCalledWith('ollama');

    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ providerId: 'grok-ollama', model: 'gemma3:27b', effort: undefined })],
      turnId: 'turn-daemon-model',
      wake: { kind: 'message', message: { id: 'message-daemon-model' } },
    });
    expect(result).toMatchObject({ success: true });
    expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemma3:27b' }), 'internal');
  });

  // `null` (list unreadable) must not collapse to `[]` (nothing installed) — a
  // daemon that is merely down would otherwise wipe the provider off the catalog.
  it('keeps the record list when the daemon list cannot be read', async () => {
    mocks.providers = [{
      id: 'grok-ollama', name: 'Grok (Ollama)', type: 'cli', enabled: true, command: 'grok',
      ollamaBacked: true, models: ['qwen3-coder:30b'], defaultModel: 'qwen3-coder:30b',
    }];
    mocks.listManagedBackendModels.mockResolvedValue({ models: [], error: 'daemon not running' });

    const catalog = await readPersistentMindTaskCatalog();
    // Asserting the call as well as the result: without it this passes just as
    // green against a build that never consults the daemon at all.
    expect(mocks.listManagedBackendModels).toHaveBeenCalledWith('ollama');
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual(['qwen3-coder:30b']);
  });

  // A cloud provider enumerates its own catalog, so a retired id is still refused.
  it('still refuses a retired model on a non-local provider', async () => {
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'gpt-4' })],
      turnId: 'turn-retired-model',
      wake: { kind: 'message', message: { id: 'message-retired-model' } },
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('filters the model-facing catalog while retaining all apps for the settings inventory', async () => {
    mocks.apps.push({ id: 'second-app', name: 'Second App', repoPath: '/example/second-app' });

    const filtered = await readPersistentMindTaskCatalog({ allowedAppIds: ['portos'] });
    const inventory = await readPersistentMindTaskCatalog({ allowedAppIds: ['portos'], includeAllApps: true });

    expect(filtered.apps.map((app) => app.id)).toEqual(['portos']);
    expect(inventory.apps.map((app) => app.id)).toEqual(['portos', 'second-app']);
  });

  it('omits blocked and unknown providers while publishing bounded reason-code aggregates', async () => {
    mocks.providers.push(
      { id: 'claude', name: 'Claude', type: 'cli', enabled: true, command: 'claude' },
      { id: 'grok', name: 'Grok', type: 'cli', enabled: true, command: 'grok' },
    );
    mocks.getProviderPrerequisiteReadinessMap.mockReturnValue({
      codex: { status: 'ready', reasonCodes: [] },
      claude: { status: 'blocked', reasonCodes: ['runtime', 'inheritedApiKey'] },
      grok: { status: 'unknown', reasonCodes: ['runtime-unprobed'] },
    });

    const catalog = await readPersistentMindTaskCatalog();
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['codex']);
    expect(catalog.providerReadiness).toEqual({
      blockedCount: 1,
      blockedReasonCodes: ['inheritedApiKey', 'runtime'],
      unknownCount: 1,
      unknownReasonCodes: ['runtime-unprobed'],
    });
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog });
    expect(prompt).toContain('"blockedCount":1');
    expect(prompt).toContain('"runtime-unprobed"');
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

  it('shows the mind what the CoS queue already holds, newest first, including completed work', async () => {
    mocks.cosTasks = [
      {
        id: 'sys-mind-older',
        status: 'completed',
        description: 'Unify the tool-calling interface\nsecond line ignored',
        metadata: { app: 'portos', updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      {
        id: 'sys-newer',
        status: 'in_progress',
        description: 'Fix the npm engine mismatch',
        metadata: { app: 'portos', updatedAt: '2026-09-03T00:00:00.000Z' },
      },
    ];

    const inventory = await readPersistentMindTaskInventory();
    expect(inventory).toEqual([
      { id: 'sys-newer', status: 'in_progress', description: 'Fix the npm engine mismatch', appId: 'portos', queuedByMind: false },
      { id: 'sys-mind-older', status: 'completed', description: 'Unify the tool-calling interface', appId: 'portos', queuedByMind: true },
    ]);

    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog: await readPersistentMindTaskCatalog(), inventory });
    expect(prompt).toContain('Unify the tool-calling interface');
    expect(prompt).toContain('do not re-queue it');
  });

  it('bounds a long CoS queue before it enters the reasoning prompt', async () => {
    const inventory = Array.from({ length: 200 }, (_, index) => ({
      id: `sys-mind-${index}`,
      status: 'completed',
      description: 'D'.repeat(160),
      appId: 'portos',
      queuedByMind: true,
    }));
    const prompt = buildPersistentMindTaskCapabilityPrompt({ enabled: true, catalog: { apps: [], providers: [] }, inventory });
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain('sys-mind-0');
  });

  it('reuses tracker resolution for repeated catalog reads', async () => {
    mocks.apps = [{ id: 'cached-app', name: 'Cached App', repoPath: '/example/cached-app' }];
    await readPersistentMindTaskCatalog();
    await readPersistentMindTaskCatalog();

    expect(mocks.resolveAppWorkTracker).toHaveBeenCalledTimes(1);
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

  it('blocks only the validation checks a task explicitly requires', async () => {
    mocks.workspacePreflight.mockResolvedValue({ readiness: 'degraded', warnings: [] });
    mocks.assessWorkspaceReadiness.mockReturnValue({
      readiness: 'blocked',
      requiredValidation: ['dependencies'],
      blockers: [{ check: 'dependencies', status: 'unavailable', message: 'Dependencies are absent.' }],
      warnings: [],
    });

    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ requiredValidation: ['dependencies'] })],
      turnId: 'turn-required-validation',
      wake: { kind: 'message', message: { id: 'message-required-validation' } },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Dependencies are absent') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('queues plan-and-file mode only for an app with an issue tracker', async () => {
    mocks.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    const results = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ planOnly: true, prCompletion: undefined })],
      turnId: 'turn-plan-only',
      wake: { kind: 'message', message: { id: 'message-plan-only' } },
    });

    expect(results).toMatchObject([{ success: true }]);
    expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({ planOnly: true }), 'internal');
    expect(mocks.addTask.mock.calls[0][0]).not.toHaveProperty('openPR');
    expect(mocks.addTask.mock.calls[0][0]).not.toHaveProperty('prCompletion');
  });

  it('rejects plan-and-file mode for PLAN.md apps before queueing', async () => {
    mocks.getAppWorkTracker.mockResolvedValue({ resolved: 'plan' });
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ planOnly: true, prCompletion: undefined })],
      turnId: 'turn-plan-tracker',
      wake: { kind: 'message', message: { id: 'message-plan-tracker' } },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('GitHub or GitLab') });
    expect(mocks.addTask).not.toHaveBeenCalled();
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

  it('rejects a task targeting an app outside the explicit allowlist', async () => {
    mocks.root.config.persistentMindCapabilities.allowedAppIds = [];
    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest()],
      turnId: 'turn-revoked-app',
      wake: { kind: 'message', message: { id: 'message-revoked-app' } },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
    expect(mocks.addTask).not.toHaveBeenCalled();
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

  it('queues Ultra for Sol and rejects it for a Codex model without Ultra', async () => {
    const [supported] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'gpt-5.6-sol', effort: 'ultra' })],
      turnId: 'turn-ultra',
      wake: { kind: 'message', message: { id: 'message-ultra' } },
    });
    expect(supported).toMatchObject({ success: true });
    expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol', effort: 'ultra',
    }), 'internal');

    mocks.addTask.mockClear();
    const results = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest({ model: 'invented' }), taskRequest({ model: 'gpt-5.6-luna', effort: 'ultra' })],
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

  it('revalidates readiness immediately before queueing and rejects a mid-turn change', async () => {
    await readPersistentMindTaskCatalog();
    mocks.getProviderPrerequisiteReadinessMap.mockReturnValue({
      codex: { status: 'blocked', reasonCodes: ['runtime'] },
    });

    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest()],
      turnId: 'turn-readiness-change',
      wake: { kind: 'message', message: { id: 'message-readiness-change' } },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not ready (runtime)') });
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('keeps an unprobed provider distinct from a ready provider', async () => {
    mocks.getProviderPrerequisiteReadinessMap.mockReturnValue({
      codex: { status: 'unknown', reasonCodes: ['runtime-unprobed'] },
    });

    const [result] = await executePersistentMindTaskRequests({
      taskRequests: [taskRequest()],
      turnId: 'turn-readiness-unknown',
      wake: { kind: 'message', message: { id: 'message-readiness-unknown' } },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('still being checked') });
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
