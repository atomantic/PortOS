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
  getStatus: vi.fn(async () => ({ models: [{ id: 'example:latest', name: 'Example', size: 100 }] })),
  getLoadedModels: vi.fn(async () => [{ id: 'example:latest', name: 'Example', sizeVram: 80 }]),
  getModelsDir: vi.fn(() => '/example/ollama'),
}));
vi.mock('./lmStudioManager.js', () => ({
  getAvailableModels: vi.fn(async () => [{ id: 'example/lmstudio', name: 'LM Example', size: 120 }]),
  getLoadedModels: vi.fn(async () => []),
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
