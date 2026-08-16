import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  statfs: vi.fn(async () => ({ blocks: 1000, bsize: 100, bavail: 250 })),
}));
vi.mock('../lib/db.js', () => ({
  query: vi.fn(async () => ({ rows: [{ bytes: '4096' }] })),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: {
    root: '/example/portos',
    browserDownloads: '/example/Downloads',
  },
  dirSize: vi.fn(async (path) => path.includes('Downloads') ? 900 : 100),
}));
vi.mock('../lib/promptRunner.js', () => ({
  resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'codex' }, selectedModel: 'gpt-example' })),
  assertProvider: vi.fn(),
  runPromptThroughProvider: vi.fn(async () => ({
    text: JSON.stringify({
      summary: 'Start with the reproducible cache.',
      recommendations: [{
        candidateId: 'candidate-2',
        priority: 'first',
        reason: 'It is low risk.',
        tradeoff: 'It will be rebuilt.',
      }],
      cautions: [],
    }),
    runId: 'run-example',
    provider: { id: 'codex' },
    model: 'gpt-example',
  })),
}));
vi.mock('./dataManager.js', () => ({
  getDataOverview: vi.fn(async () => ({
    totalSize: 500,
    categories: [{
      key: 'cache', label: 'Remote API Cache', description: 'Reproducible metadata',
      size: 300, deletable: true, purgeScope: 'category', busy: false,
    }],
  })),
}));
vi.mock('./mediaModelStorage.js', () => ({
  listHfModelStorage: vi.fn(async () => ({
    totalBytes: 700,
    models: [{ id: 'models--example--public', repo: 'example/public', label: null, size: 700 }],
  })),
  listLoraStorage: vi.fn(async () => ({
    totalBytes: 200,
    loras: [{ filename: 'private-project.safetensors', name: 'Private Project', size: 200 }],
  })),
}));
vi.mock('./ollamaManager.js', () => ({
  getStatus: vi.fn(async () => ({ available: true, models: [{ id: 'example:latest', name: 'Example', size: 100 }] })),
  listStoredModels: vi.fn(async () => [{ id: 'example:latest', name: 'Example', size: 100 }]),
  getLoadedModels: vi.fn(async () => [{ id: 'example:latest', name: 'Example', sizeVram: 80 }]),
  getLastLoadedModelsError: vi.fn(() => null),
  getModelsDir: vi.fn(() => '/example/ollama'),
}));
vi.mock('./lmStudioManager.js', () => ({
  checkLMStudioAvailable: vi.fn(async () => true),
  getAvailableModels: vi.fn(async () => [{ id: 'example/lmstudio', name: 'LM Example', size: 120 }]),
  listStoredModels: vi.fn(async () => [{ id: 'example/lmstudio', name: 'lmstudio', size: 120 }]),
  getLoadedModels: vi.fn(async () => []),
  getLastLoadedModelsError: vi.fn(() => null),
  getLastListError: vi.fn(() => null),
  getModelsDir: vi.fn(async () => '/example/lmstudio'),
}));
vi.mock('./mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(() => [
    { id: 'image-1', kind: 'image', status: 'queued' },
    { id: 'video-1', kind: 'video', status: 'running' },
  ]),
}));
vi.mock('./cos.js', () => ({
  getAllTasks: vi.fn(async () => ({
    user: { grouped: { pending: [{ id: 'task-1' }], in_progress: [] } },
    cos: {
      grouped: { pending: [{ id: 'approval-1', approvalRequired: true }], in_progress: [] },
      awaitingApproval: [{ id: 'approval-1', approvalRequired: true }],
    },
  })),
  getStatus: vi.fn(async () => ({ running: true, paused: false, activeAgents: 0, pausedAgents: 0 })),
}));

const promptRunner = await import('../lib/promptRunner.js');
const fileUtils = await import('../lib/fileUtils.js');
const ollamaManager = await import('./ollamaManager.js');
const lmStudioManager = await import('./lmStudioManager.js');
const {
  buildCleanupCandidates,
  buildSystemResourceReport,
  buildSystemResourceTriagePrompt,
  resetSystemResourceReportCache,
  triageSystemResources,
} = await import('./systemResources.js');

describe('system resource reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSystemResourceReportCache();
    fileUtils.dirSize.mockImplementation(async (path) => path.includes('Downloads') ? 900 : 100);
    ollamaManager.getStatus.mockResolvedValue({
      available: true,
      models: [{ id: 'example:latest', name: 'Example', size: 100 }],
    });
    ollamaManager.listStoredModels.mockResolvedValue([{ id: 'example:latest', name: 'Example', size: 100 }]);
    ollamaManager.getLoadedModels.mockResolvedValue([{ id: 'example:latest', name: 'Example', sizeVram: 80 }]);
    ollamaManager.getLastLoadedModelsError.mockReturnValue(null);
    lmStudioManager.checkLMStudioAvailable.mockResolvedValue(true);
    lmStudioManager.getAvailableModels.mockResolvedValue([{ id: 'example/lmstudio', name: 'LM Example', size: 120 }]);
    lmStudioManager.listStoredModels.mockResolvedValue([{ id: 'example/lmstudio', name: 'lmstudio', size: 120 }]);
    lmStudioManager.getLoadedModels.mockResolvedValue([]);
    lmStudioManager.getLastLoadedModelsError.mockReturnValue(null);
    lmStudioManager.getLastListError.mockReturnValue(null);
  });

  it('combines storage, model residency, and live queue summaries', async () => {
    const report = await buildSystemResourceReport();
    expect(report.filesystem).toEqual({
      totalBytes: 100000,
      usedBytes: 75000,
      freeBytes: 25000,
      usagePercent: 75,
    });
    expect(report.summary).toMatchObject({ loadedModels: 1, queuedJobs: 3, runningJobs: 1 });
    expect(report.queues.agents).toMatchObject({ pendingSystem: 1, awaitingApproval: 1 });
    expect(report.models.downloaded.map((model) => model.backend)).toEqual(
      expect.arrayContaining(['huggingface', 'lora', 'ollama', 'lmstudio']),
    );
    expect(report.cleanupCandidates.find((item) => item.id === 'ollama:example:latest')).toMatchObject({
      loaded: true,
      action: null,
    });
    expect(report.cleanupCandidates.find((item) => item.id === 'lora:private-project.safetensors')).toMatchObject({
      risk: 'high',
    });
  });

  it('only enables one-click data purges for the conservative allowlist', () => {
    const candidates = buildCleanupCandidates({
      categories: [
        { key: 'cache', label: 'Cache', description: 'Safe', size: 50, deletable: true, purgeScope: 'category', busy: false },
        { key: 'backup', label: 'Backups', description: 'Review', size: 500, deletable: true, purgeScope: 'category', busy: false },
      ],
      downloadedModels: [],
      npmCacheBytes: 0,
    });
    expect(candidates.find((item) => item.id === 'data:cache').action).toEqual({ type: 'data-category', key: 'cache' });
    expect(candidates.find((item) => item.id === 'data:backup').action).toBeNull();
  });

  it('keeps downloaded models visible while an offline backend blocks unsafe cleanup', async () => {
    ollamaManager.getStatus.mockResolvedValue({ available: false, models: [] });
    ollamaManager.getLoadedModels.mockResolvedValue([]);
    ollamaManager.getLastLoadedModelsError.mockReturnValue('backend unavailable');

    const report = await buildSystemResourceReport();
    const model = report.models.downloaded.find((item) => item.id === 'ollama:example:latest');
    const candidate = report.cleanupCandidates.find((item) => item.id === model.id);

    expect(model).toMatchObject({ name: 'Example', residencyUnknown: true });
    expect(candidate).toMatchObject({ busy: true, manualOnly: true, action: null });
    expect(report.sourceErrors).toEqual(expect.arrayContaining(['ollama-backend', 'ollama-residency']));
  });

  it('aggregates LM Studio quantizations into one folder-scoped cleanup row', async () => {
    lmStudioManager.getAvailableModels.mockResolvedValue([
      { id: 'example/lmstudio', quantization: 'Q4_K_M', state: 'not-loaded' },
      { id: 'example/lmstudio', quantization: 'Q8_0', state: 'not-loaded' },
    ]);

    const report = await buildSystemResourceReport();
    const rows = report.models.downloaded.filter((item) => item.backend === 'lmstudio');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'lmstudio:example/lmstudio',
      action: { type: 'local-model', backend: 'lmstudio', modelId: 'example/lmstudio' },
    });
    expect(rows[0].detail).toContain('2 quantizations');
    expect(rows[0].detail).toContain('whole model folder');
  });

  it('surfaces strict size-scan failures instead of reporting a ready zero', async () => {
    fileUtils.dirSize.mockImplementation(async (path) => {
      if (path === '/example/portos/node_modules') return null;
      return path.includes('Downloads') ? 900 : 100;
    });

    const report = await buildSystemResourceReport();
    const dependencies = report.storageAreas.find((area) => area.id === 'dependencies');

    expect(dependencies).toMatchObject({ status: 'unavailable' });
    expect(report.sourceErrors).toContain('dependencies');
  });

  it('keeps model names, ids, filenames, and paths out of the AI prompt', async () => {
    const report = await buildSystemResourceReport();
    const prompt = buildSystemResourceTriagePrompt(report);
    expect(prompt).toContain('candidate-1');
    expect(prompt).not.toContain('private-project.safetensors');
    expect(prompt).not.toContain('Private Project');
    expect(prompt).not.toContain('example:latest');
    expect(prompt).not.toContain('/example/');
  });

  it('maps opaque AI candidate ids back to server-issued cleanup candidates', async () => {
    const result = await triageSystemResources({ providerId: 'codex' });
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      source: 'system-resource-triage',
    }));
    expect(result.triage.recommendations[0].candidate).toMatchObject({ id: 'data:cache' });
    expect(result.triage.recommendations[0].candidateId).toBe('data:cache');
  });
});
