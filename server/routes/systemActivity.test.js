import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const deps = vi.hoisted(() => ({ loaded: vi.fn(), loadedError: vi.fn(), runs: vi.fn(), count: vi.fn() }));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: async () => ({ status: 'absent', gpus: [] }) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ listJobs: () => [], getRunningJob: () => null }));
vi.mock('../services/imageTo3d/models.js', () => ({ listGeneratingModelSummaries: async () => [] }));
vi.mock('../services/ollamaManager.js', () => ({ getLoadedModels: deps.loaded, getLastLoadedModelsError: deps.loadedError }));
vi.mock('../services/cos.js', () => ({ getPendingTaskIds: async () => [], getAgents: async () => [] }));
vi.mock('../services/cosState.js', () => ({ readPersistentMindStateForSafetyCheck: async () => ({ trusted: true }) }));
vi.mock('../services/appOperations.js', () => ({ listActiveAppOperations: () => [] }));
vi.mock('../services/updateChecker.js', () => ({ isUpdateInProgress: () => false }));
vi.mock('../services/runner.js', () => ({ getActiveRunCount: deps.count, getActiveRunSummaries: deps.runs }));
vi.mock('../services/backup.js', () => ({ isBackupInProgress: () => false }));

let app;
describe('system activity routes', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    deps.count.mockResolvedValue(1);
    deps.runs.mockResolvedValue([{ runId: 'run-1', providerId: 'ollama', model: 'example:7b', source: 'music-video-document', startedAt: '2026-01-01T00:00:00Z' }]);
    deps.loaded.mockResolvedValue([{ id: 'example:7b', name: 'example:7b', size: 1000, sizeVram: 1000, expiresAt: null }]);
    deps.loadedError.mockReturnValue(null);
    app = express();
    const { default: routes } = await import('./systemActivity.js');
    app.use('/api/system', routes);
  });

  it('serves run metadata and cached Ollama residency through the activity route', async () => {
    const response = await request(app).get('/api/system/activity');
    expect(response.status).toBe(200);
    expect(response.body.llm).toEqual({ trusted: true, active: 1, runs: await deps.runs() });
    expect(response.body.llm.runs[0]).not.toHaveProperty('prompt');
    expect(response.body.ollama).toMatchObject({ trusted: true, models: [{ name: 'example:7b' }] });
    expect(response.body.activity.idle).toBe(false);
    await request(app).get('/api/system/gpu-telemetry');
    expect(deps.loaded).toHaveBeenCalledTimes(1);
    expect(deps.loaded).toHaveBeenCalledWith({ timeout: 1500 });
  });

  it('keeps the snapshot successful and active when Ollama is unreachable', async () => {
    deps.loaded.mockRejectedValue(new Error('daemon unavailable'));
    const response = await request(app).get('/api/system/activity');
    expect(response.status).toBe(200);
    expect(response.body.llm.active).toBe(1);
    expect(response.body.ollama).toEqual({ trusted: false, models: [] });
    expect(response.body.activity.idle).toBe(false);
  });

  it('does not confuse a failed residency read with an empty daemon', async () => {
    deps.loaded.mockResolvedValue([]);
    deps.loadedError.mockReturnValue('residency probe failed');
    const response = await request(app).get('/api/system/gpu-telemetry');
    expect(response.status).toBe(200);
    expect(response.body.ollama).toEqual({ trusted: false, models: [] });
  });
});
