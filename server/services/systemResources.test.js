import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./modelDeduplication.js', () => ({ scanModelDuplicates: vi.fn(async () => ({ pinokioDetected: false, items: [], totalReclaimableBytes: 0 })) }));

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
    data: '/example/data',
    browserDownloads: '/example/Downloads',
  },
  dirSize: vi.fn(async (path) => path.includes('Downloads') ? 900 : 100),
}));
vi.mock('./promptRunner.js', () => ({
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
vi.mock('./modelStoreStorage.js', () => ({
  listModelStore: vi.fn(async (backend) => backend === 'mtplx'
    ? { totalBytes: 60, items: [
      { key: 'org--ckpt', name: 'org/ckpt', detail: 'MTPLX checkpoint', size: 50 },
      { key: 'session-bank', name: 'MTPLX session bank', detail: 'cache', size: 10, risk: 'low', cleanupReason: 'Rebuilt on demand.' },
    ] }
    : { totalBytes: 0, items: [] }),
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
  getQueueCapacity: vi.fn(() => ({
    totals: { queued: 3, running: 1 },
    byKind: {
      image: { queued: 1, running: 0 },
      video: { queued: 0, running: 1 },
      'video-upscale': { queued: 2, running: 0 },
    },
  })),
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
  getAgents: vi.fn(async () => []),
}));
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));
// The manifest is the report's persistence side effect, and its real writer needs
// JSON helpers the fileUtils mock above deliberately omits. Doubled so the
// reconcile call can be asserted rather than swallowed by its best-effort catch.
vi.mock('./modelManifest.js', () => ({
  getModelManifest: vi.fn(async () => ({ reconciledAt: null, models: [] })),
  reconcileModelManifest: vi.fn(async () => ({ reconciledAt: '2026-08-16T00:00:00.000Z', added: 0, removed: 0, trusted: [] })),
}));

const promptRunner = await import('./promptRunner.js');
const fsPromises = await import('fs/promises');
const db = await import('../lib/db.js');
const fileUtils = await import('../lib/fileUtils.js');
const dataManager = await import('./dataManager.js');
const mediaModelStorage = await import('./mediaModelStorage.js');
const modelStoreStorage = await import('./modelStoreStorage.js');
const ollamaManager = await import('./ollamaManager.js');
const lmStudioManager = await import('./lmStudioManager.js');
const cos = await import('./cos.js');
const settings = await import('./settings.js');
const modelManifest = await import('./modelManifest.js');
const {
  buildCleanupCandidates,
  buildSystemResourceReport,
  buildSystemResourceTriagePrompt,
  getTrackedModelInventory,
  resetSystemResourceReportCache,
  triageSystemResources,
} = await import('./systemResources.js');

describe('system resource reporting', () => {
  afterEach(() => vi.restoreAllMocks());
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
    settings.getSettings.mockResolvedValue({});
  });

  it('reports data capacity independently and preserves unknown data probes', async () => {
    fsPromises.statfs.mockResolvedValueOnce({ blocks: 100, bsize: 1, bavail: 80 })
      .mockResolvedValueOnce({ blocks: 100, bsize: 1, bavail: 1 });
    const report = await buildSystemResourceReport();
    expect(report.filesystem.usagePercent).toBe(20);
    expect(report.dataFilesystem).toEqual({ totalBytes: 100, usedBytes: 99, freeBytes: 1, usagePercent: 99 });
    expect(fsPromises.statfs).toHaveBeenCalledWith(fileUtils.PATHS.data);
    fsPromises.statfs.mockResolvedValueOnce({ blocks: 100, bsize: 1, bavail: 80 }).mockRejectedValueOnce(new Error('private mount'));
    const failed = await buildSystemResourceReport();
    expect(failed.filesystem.usagePercent).toBe(20);
    expect(failed.dataFilesystem).toBeNull();
    expect(failed.sourceErrors).toContain('data-filesystem');
    expect(JSON.stringify(failed)).not.toContain('private mount');
    expect((await buildSystemResourceReport()).dataFilesystem.usagePercent).toBe(75);
  });

  it('combines storage, model residency, and live queue summaries', async () => {
    const report = await buildSystemResourceReport();
    expect(dataManager.getDataOverview).toHaveBeenCalledWith({ strict: true });
    expect(lmStudioManager.checkLMStudioAvailable).toHaveBeenCalledWith(true);
    expect(lmStudioManager.getAvailableModels).toHaveBeenCalledWith(true);
    expect(report.filesystem).toEqual({
      totalBytes: 100000,
      usedBytes: 75000,
      freeBytes: 25000,
      usagePercent: 75,
    });
    expect(report.summary).toMatchObject({ loadedModels: 1, queuedJobs: 5, runningJobs: 1 });
    expect(report.queues.media).toMatchObject({
      queued: 3,
      running: 1,
      byKind: expect.objectContaining({ 'video-upscale': { queued: 2, running: 0 } }),
    });
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

  it('exposes disabled local backends separately from the full source error list', async () => {
    settings.getSettings.mockResolvedValue({ localLlm: { lmstudio: { disabled: true } } });
    lmStudioManager.checkLMStudioAvailable.mockResolvedValue(false);
    lmStudioManager.getAvailableModels.mockRejectedValueOnce(new Error('backend unavailable'));
    lmStudioManager.listStoredModels.mockRejectedValueOnce(new Error('inventory unavailable'));
    lmStudioManager.getLoadedModels.mockRejectedValueOnce(new Error('residency unavailable'));
    lmStudioManager.getLastLoadedModelsError.mockReturnValue('residency unavailable');
    lmStudioManager.getLastListError.mockReturnValue('inventory unavailable');

    const report = await buildSystemResourceReport();

    expect(report.disabledSources).toEqual(['lmstudio']);
    expect(report.sourceErrors).toEqual(expect.arrayContaining([
      'lmstudio-backend',
      'lmstudio-inventory',
      'lmstudio-catalog',
      'lmstudio-residency',
    ]));
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
      if (String(path).replaceAll('\\', '/') === '/example/portos/node_modules') return null;
      return path.includes('Downloads') ? 900 : 100;
    });

    const report = await buildSystemResourceReport();
    const dependencies = report.storageAreas.find((area) => area.id === 'dependencies');

    expect(dependencies).toMatchObject({ status: 'unavailable' });
    expect(report.sourceErrors).toContain('dependencies');
  });

  it('surfaces a failed filesystem capacity probe as unknown', async () => {
    fsPromises.statfs.mockRejectedValueOnce(new Error('statfs unavailable'));

    const report = await buildSystemResourceReport();

    expect(report.filesystem).toBeNull();
    expect(report.sourceErrors).toContain('filesystem');
  });

  it('marks an unreadable PortOS data scan unavailable', async () => {
    dataManager.getDataOverview.mockRejectedValueOnce(new Error('permission denied'));

    const report = await buildSystemResourceReport();
    const dataArea = report.storageAreas.find((area) => area.id === 'portos-data');

    expect(dataArea).toMatchObject({ sizeBytes: null, status: 'unavailable' });
    expect(report.sourceErrors).toContain('portos-data');
    expect(report.cleanupCandidates.some((candidate) => candidate.kind === 'data')).toBe(false);
  });

  it('moves a task its agent already holds from pending to in flight, without changing the total', async () => {
    // An agent is registered as running a beat before its task leaves 'pending'
    // (lib/cosSpawnWindow.js), so counting the two lists independently reported
    // the same task as queued AND running — "Agent pending 1 / Agent running 1"
    // for a queue of one. It must move sides, not appear on both and not vanish.
    cos.getAllTasks.mockResolvedValueOnce({
      user: { grouped: { pending: [{ id: 'user/42', status: 'pending' }], in_progress: [] } },
      cos: { grouped: { pending: [], in_progress: [] }, awaitingApproval: [] },
    });
    cos.getAgents.mockResolvedValueOnce([{ id: 'agent-1', taskId: 'user/42', status: 'running', startedAt: new Date().toISOString() }]);

    const report = await buildSystemResourceReport();

    expect(report.queues.agents).toMatchObject({ pendingUser: 0, pendingSystem: 0, inProgress: 1 });
    // The media lane contributes a fixed 3 queued / 1 running, so the one agent
    // task crossing sides leaves the combined total at 5 either way.
    expect(report.summary).toMatchObject({ queuedJobs: 3, runningJobs: 2 });
  });

  it('keeps failed census reconciliation unknown and restores spawn-window counts on recovery', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tasks = {
      user: { grouped: { pending: [{ id: 'user/42', status: 'pending' }], in_progress: [] } },
      cos: { grouped: { pending: [{ id: 'approval-1', approvalRequired: true }], in_progress: [] }, awaitingApproval: [{ id: 'approval-1' }] },
    };
    cos.getAllTasks.mockResolvedValueOnce(tasks).mockResolvedValueOnce(tasks).mockResolvedValueOnce(tasks);
    cos.getStatus.mockResolvedValueOnce({ running: true, paused: false, activeAgents: 1, pausedAgents: 2 });
    const failure = Object.assign(new Error('private census path'), { code: 'EIO' });
    cos.getAgents.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([{ id: 'agent-1', taskId: 'user/42', status: 'running', startedAt: new Date().toISOString() }]);

    const failed = await buildSystemResourceReport();
    expect(failed.sourceErrors).toEqual(['agent-census']);
    expect(failed.queues.agents).toEqual({
      pendingUser: null, pendingSystem: null, inProgress: null, awaitingApproval: 1,
      activeAgents: 1, pausedAgents: 2, daemonRunning: true, daemonPaused: false,
    });
    expect(failed.queues.media).toMatchObject({ queued: 3, running: 1 });
    expect(failed.summary).toMatchObject({ queuedJobs: null, runningJobs: null });
    const prompt = buildSystemResourceTriagePrompt(failed);
    expect(prompt).toContain('"unavailableSources": [\n    "agent-census"');
    expect(prompt).toContain('"queuedJobs": null');
    expect(prompt).toContain('"runningJobs": null');
    expect(prompt).not.toContain('private census path');

    await buildSystemResourceReport();
    expect(errors).toHaveBeenCalledExactlyOnceWith('❌ Resource probe unavailable (source=agent-census, code=EIO)');
    const recovered = await buildSystemResourceReport();
    expect(recovered.sourceErrors).not.toContain('agent-census');
    expect(recovered.queues.agents).toMatchObject({ pendingUser: 0, pendingSystem: 1, inProgress: 1 });
    expect(recovered.summary).toMatchObject({ queuedJobs: 4, runningJobs: 2 });
    expect(logs).toHaveBeenCalledExactlyOnceWith('✅ Resource probe recovered (source=agent-census)');
    await buildSystemResourceReport();
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('treats a successful empty census as measured persisted-task counts', async () => {
    cos.getAllTasks.mockResolvedValueOnce({
      user: { grouped: { pending: [], in_progress: [{ id: 'user/42' }] } },
      cos: { grouped: { pending: [], in_progress: [] }, awaitingApproval: [] },
    });
    cos.getAgents.mockResolvedValueOnce([]);
    const report = await buildSystemResourceReport();
    expect(report.sourceErrors).not.toContain('agent-census');
    expect(report.queues.agents).toMatchObject({ pendingUser: 0, pendingSystem: 0, inProgress: 1 });
    expect(report.summary).toMatchObject({ queuedJobs: 3, runningJobs: 2 });
  });

  it('preserves failed agent queue and status probes as unknown', async () => {
    cos.getAllTasks.mockRejectedValueOnce(new Error('task store unavailable'));
    cos.getStatus.mockRejectedValueOnce(new Error('daemon status unavailable'));

    const report = await buildSystemResourceReport();

    expect(report.queues.agents).toBeNull();
    expect(report.summary).toMatchObject({ queuedJobs: null, runningJobs: null });
    expect(report.sourceErrors).toEqual(expect.arrayContaining(['agent-queue', 'agent-status']));
  });

  // Regression: the file-system model stores (MTPLX, Hunyuan3D, xet cache, Pixie
  // Forge) were invisible to the report. Each is its own backend, sized, armed with
  // a server-issued action, and a failed read marks the source unavailable instead
  // of reading as an empty store.
  it('inventories the file-system model stores with delete and clear actions', async () => {
    const report = await buildSystemResourceReport();

    const ckpt = report.models.downloaded.find((row) => row.id === 'mtplx:org--ckpt');
    expect(ckpt).toMatchObject({ backend: 'mtplx', sizeBytes: 50, action: { type: 'model-store', backend: 'mtplx', key: 'org--ckpt' } });
    expect(report.models.downloaded.find((row) => row.id === 'mtplx:session-bank')).toMatchObject({ risk: 'low' });
    expect(report.models.totals.mtplx).toBe(60);
    expect(report.storageAreas.find((area) => area.id === 'mtplx')).toMatchObject({ sizeBytes: 60, status: 'ready' });
    expect(report.storageAreas.find((area) => area.id === 'pixie-forge')).toMatchObject({ sizeBytes: 0, status: 'ready' });
    expect(report.cleanupCandidates.find((candidate) => candidate.id === 'mtplx:org--ckpt').action)
      .toEqual({ type: 'model-store', backend: 'mtplx', key: 'org--ckpt' });
  });

  it('marks an unreadable model store unavailable rather than empty', async () => {
    modelStoreStorage.listModelStore.mockRejectedValueOnce(new Error('permission denied'));

    const report = await buildSystemResourceReport();

    expect(report.sourceErrors).toContain('mtplx');
    expect(report.models.totals.mtplx).toBeNull();
  });

  it('keeps daemon status unknown when only the COS status probe fails', async () => {
    cos.getStatus.mockRejectedValueOnce(new Error('daemon status unavailable'));

    const report = await buildSystemResourceReport();

    expect(report.queues.agents).toMatchObject({
      activeAgents: null,
      pausedAgents: null,
      daemonRunning: null,
      daemonPaused: null,
    });
    expect(report.sourceErrors).toContain('agent-status');
  });

  it('returns an unknown footprint instead of zero when every area scan fails', async () => {
    dataManager.getDataOverview.mockRejectedValueOnce(new Error('data unavailable'));
    db.query.mockRejectedValueOnce(new Error('database unavailable'));
    mediaModelStorage.listHfModelStorage.mockRejectedValueOnce(new Error('cache unavailable'));
    mediaModelStorage.listLoraStorage.mockRejectedValueOnce(new Error('lora store unavailable'));
    modelStoreStorage.listModelStore.mockRejectedValue(new Error('store unreadable'));
    fileUtils.dirSize.mockResolvedValue(null);

    const report = await buildSystemResourceReport();

    expect(report.storageAreas.every((area) => area.sizeBytes == null)).toBe(true);
    expect(report.summary.knownFootprintBytes).toBeNull();
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

/**
 * The manifest side of the report: a scan heals the persisted inventory, and the
 * persisted inventory is what the Status page renders when no scan has run.
 */
describe('tracked model inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSystemResourceReportCache();
    modelManifest.reconcileModelManifest.mockResolvedValue({
      reconciledAt: '2026-08-16T00:00:00.000Z', added: 0, removed: 0, trusted: [],
    });
  });

  it('reconciles the manifest from every scan, carrying the scan\'s own trust signals', async () => {
    settings.getSettings.mockResolvedValue({ localLlm: { lmstudio: { disabled: true } } });
    const report = await buildSystemResourceReport();

    const [rows, trust] = modelManifest.reconcileModelManifest.mock.calls[0];
    expect(rows).toBe(report.models.downloaded);
    // Without these the reconcile would prune a disabled or unreachable backend's
    // rows against a scan that could never have listed them.
    expect(trust.disabledSources).toContain('lmstudio');
    expect(trust.sourceErrors).toEqual(report.sourceErrors);
    expect(report).toMatchObject({ inventorySource: 'scan', manifestReconciledAt: '2026-08-16T00:00:00.000Z' });
  });

  it('still returns a report when the manifest could not be written', async () => {
    modelManifest.reconcileModelManifest.mockResolvedValue(null);
    const report = await buildSystemResourceReport();
    expect(report.manifestReconciledAt).toBeNull();
    expect(report.models.downloaded.length).toBeGreaterThan(0);
  });

  it('serves the manifest as a scan-shaped report, with the same cleanup candidates', async () => {
    modelManifest.getModelManifest.mockResolvedValue({
      reconciledAt: '2026-08-16T00:00:00.000Z',
      models: [
        {
          id: 'hf:models--example--public', backend: 'huggingface', key: 'models--example--public',
          name: 'example/public', sizeBytes: 700, loaded: false, residencyUnknown: false, inventoryUnknown: false,
          managePath: '/models/media', action: { type: 'hf-model', dirName: 'models--example--public' },
        },
        {
          id: 'ollama:example:latest', backend: 'ollama', key: 'example:latest', name: 'Example',
          sizeBytes: 100, loaded: false, residencyUnknown: true, inventoryUnknown: false,
          managePath: '/models/llms', action: { type: 'local-model', backend: 'ollama', modelId: 'example:latest' },
        },
      ],
    });

    const inventory = await getTrackedModelInventory();
    expect(inventory).toMatchObject({ inventorySource: 'manifest', reconciledAt: '2026-08-16T00:00:00.000Z' });
    expect(inventory.models.totals).toMatchObject({ huggingface: 700, ollama: 100, lmstudio: null, all: 800 });
    // No scan means no residency probe, so the local row must stay un-armed: a
    // one-click delete offered off the record alone could remove loaded weights.
    const [hf, ollama] = inventory.cleanupCandidates;
    expect(hf).toMatchObject({ id: 'hf:models--example--public', manualOnly: false, action: { type: 'hf-model', dirName: 'models--example--public' } });
    expect(ollama).toMatchObject({ id: 'ollama:example:latest', manualOnly: true, action: null });
    // And the duplicate-weight scan — the most expensive walk of them all — is
    // never run for a manifest read.
    expect(inventory.modelDuplicates).toBeNull();
  });

  it('reports a never-reconciled install as unverified rather than empty', async () => {
    modelManifest.getModelManifest.mockResolvedValue({ reconciledAt: null, models: [] });
    const inventory = await getTrackedModelInventory();
    expect(inventory.reconciledAt).toBeNull();
    expect(inventory.models.downloaded).toEqual([]);
    expect(inventory.models.totals.all).toBeNull();
  });
});
