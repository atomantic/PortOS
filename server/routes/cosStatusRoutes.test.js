import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-cos-status-routes-' });
vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));
afterAll(cleanup);

// Stub non-config side effects so the real cosStatusRoutes -> cos.updateConfig -> cosState ->
// creativeDirectorRoutes / dispatchCreativeTool persistence and enforcement loop runs end-to-end
// against the isolated temp data directory.
vi.mock('../services/domainUsage.js', () => ({
  getAllDomainUsageToday: vi.fn(async () => ({})),
  getDomainBudgetStatus: vi.fn(async () => ({ withinBudget: true, exceeded: null })),
  recordDomainUsage: vi.fn(async () => {}),
}));
vi.mock('../services/memoryEmbeddings.js', () => ({ reinitialize: vi.fn() }));
vi.mock('../services/provider/providers.js', () => ({
  getProviderById: vi.fn(async () => null),
  getActiveProvider: vi.fn(async () => null),
}));
vi.mock('../services/userActionScheduleLog.js', () => ({ logCosScheduleUpdate: vi.fn(async () => {}) }));
vi.mock('../services/eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  getEvent: vi.fn(),
}));
vi.mock('../services/autonomousJobs.js', () => ({ recordJobExecution: vi.fn() }));
vi.mock('../services/notifications.js', () => ({ addNotification: vi.fn(), NOTIFICATION_TYPES: {} }));
vi.mock('../services/cos/cosHealthMonitor.js', () => ({ runHealthCheck: vi.fn(), getHealthStatus: vi.fn() }));
vi.mock('../services/cos/cosTaskStore.js', () => ({
  getPendingTaskIds: vi.fn(async () => []),
  getUserTasks: vi.fn(async () => []),
  getCosTasks: vi.fn(async () => []),
  getAllTasks: vi.fn(async () => ({ user: { tasks: [] }, cos: { tasks: [] } })),
  getTaskById: vi.fn(async () => null),
  updateTask: vi.fn(),
  sweepResolvedFailureTasks: vi.fn(),
}));
vi.mock('../services/persistent/persistentMindSupervisor.js', () => ({
  handlePersistentMindGlobalPause: vi.fn(async () => {}),
  handlePersistentMindGlobalResume: vi.fn(async () => {}),
  refreshPersistentMindWakeCadence: vi.fn(async () => {}),
}));
vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'test-instance') }));
vi.mock('../services/appActivity.js', () => ({ clearStaleActiveAgents: vi.fn(async () => ({ cleared: [] })) }));
vi.mock('../services/onDemandDrain.js', () => ({ drainOnDemandRequests: vi.fn(async () => {}) }));

// Minimal mocks for creative tool registry & creativeDirector non-tools dependencies.
vi.mock('../services/voice/tools.js', () => ({
  getToolMetadata: vi.fn((id) => (
    id === 'catalog_lookup'
      ? {
          id: 'catalog_lookup',
          description: 'VOICE catalog search description',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }
      : null
  )),
  getToolSpecs: vi.fn(() => [{
    type: 'function',
    function: {
      name: 'catalog_lookup',
      description: 'VOICE catalog search description',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  }]),
  dispatchTool: vi.fn(async () => ({ summary: 'ok', results: [] })),
}));
vi.mock('../services/universeBuilder.js', () => ({ createUniverse: vi.fn(async () => ({ id: 'u1' })), needsEntryIdPersist: vi.fn(async () => false), updateUniverse: vi.fn(async () => ({})) }));
vi.mock('../services/universeBuilderExpand.js', () => ({ expandWorldTemplate: vi.fn(async () => ({ logline: 'x' })) }));
vi.mock('../services/universeBuilderRender.js', () => ({ renderUniverseJobs: vi.fn(async () => ({ jobs: [] })) }));
vi.mock('../services/storyBuilder.js', () => ({ createStorySession: vi.fn(async () => ({ id: 's1' })), generateStep: vi.fn(async () => ({ runId: 'r1' })), generateIssuesFromArc: vi.fn(async () => ({ createdIssues: [] })) }));
vi.mock('../services/writersRoom/local.js', () => ({ createWork: vi.fn(async () => ({ id: 'w1' })) }));
vi.mock('../services/writersRoom/evaluator.js', () => ({ runAnalysis: vi.fn(async () => ({ status: 'succeeded' })) }));
const createSeriesMock = vi.fn(async () => ({ id: 'ser1' }));
vi.mock('../services/pipeline/series.js', () => ({ createSeries: createSeriesMock }));
vi.mock('../services/pipeline/seriesGenerate.js', () => ({ generateSeriesConcept: vi.fn(async () => ({ name: 'C' })) }));
vi.mock('../services/pipeline/textStages.js', () => ({ generateStage: vi.fn(async () => ({ stage: 'st' })) }));
vi.mock('../services/pipeline/seriesAutopilot/orchestrator.js', () => ({ startSeriesAutopilot: vi.fn(async () => ({ runId: 'ap1' })) }));
vi.mock('../services/pipeline/visualStages.js', () => ({
  renderComicCover: vi.fn(async () => ({})),
  renderComicBackCover: vi.fn(async () => ({})),
  renderVolumeCover: vi.fn(async () => ({})),
  renderVolumeBackCover: vi.fn(async () => ({})),
  renderComicPage: vi.fn(async () => ({})),
  refineComicPageRender: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn(() => ({ jobId: 'mj1' })) }));
vi.mock('../services/creativeDirector/local.js', () => ({
  listProjects: vi.fn(async () => []),
  getProjectsByIds: vi.fn(async () => []),
  getProject: vi.fn(async () => null),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  setTreatment: vi.fn(),
  setPlan: vi.fn(),
  updatePlanStep: vi.fn(),
  updateScene: vi.fn(),
}));
vi.mock('../services/creativeDirector/autoCast.js', () => ({ suggestCastForBrief: vi.fn(async () => []), applyAutoCastToProject: vi.fn(), toSuggestionView: vi.fn() }));
vi.mock('../services/creativeDirector/firstPassGen.js', () => ({ enqueueFirstPassPortraits: vi.fn(), enqueueFirstPassSceneFrames: vi.fn() }));
vi.mock('../services/creativeDirector/firstPassMusicGen.js', () => ({ enqueueFirstPassMusicBed: vi.fn() }));
vi.mock('../services/creativeDirector/completionHook.js', () => ({ startCreativeDirectorProject: vi.fn(), advanceAfterSceneSettled: vi.fn() }));
vi.mock('../services/creativeDirector/stopProject.js', () => ({ stopProject: vi.fn() }));
vi.mock('../services/creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: vi.fn() }));
vi.mock('../services/creativeDirector/videoReview.js', () => ({ reviewVideo: vi.fn(), getVideoReview: vi.fn() }));
vi.mock('../services/creativeDirector/videoExecution.js', () => ({ getVideoExecutionPreview: vi.fn(), startVideoExecution: vi.fn(), pauseVideoExecution: vi.fn() }));
vi.mock('../services/catalog/catalogDB.js', () => ({ listIngredients: vi.fn(async () => ({ items: [] })) }));
vi.mock('../services/settings.js', async (importOriginal) => ({ ...(await importOriginal()), getSettings: vi.fn(async () => ({})) }));

describe('cosStatusRoutes domainAutonomy.creative persistence & enforcement', () => {
  let app;
  let dispatchCreativeTool;

  beforeEach(async () => {
    vi.resetModules();
    rmSync(join(tempRoot, 'cos'), { recursive: true, force: true });
    mkdirSync(join(tempRoot, 'cos'), { recursive: true });
    vi.clearAllMocks();

    const [{ default: cosStatusRoutes }, { default: creativeDirectorRoutes }, toolRegistry] = await Promise.all([
      import('./cosStatusRoutes.js'),
      import('./creativeDirector.js'),
      import('../services/creative/toolRegistry.js'),
    ]);
    dispatchCreativeTool = toolRegistry.dispatchCreativeTool;

    app = express();
    app.use(express.json());
    app.use('/api/cos', cosStatusRoutes);
    app.use('/api/creative-director', creativeDirectorRoutes);
    app.use(errorMiddleware);
  });

  it('persists domainAutonomy.creative overrides, preserves them across unrelated domain saves, and clears on null', async () => {
    // 1. Set cos=off while creative is unset → creative inherits cos ('off').
    const initRes = await request(app).put('/api/cos/config').send({ domainAutonomy: { cos: 'off' } });
    expect(initRes.status).toBe(200);
    expect('creative' in initRes.body.domainAutonomy).toBe(false);
    expect((await request(app).get('/api/creative-director/tools')).body.mode).toBe('off');
    expect(await dispatchCreativeTool('pipeline_createSeries', { name: 'S' })).toMatchObject({ ok: false, reason: 'autonomy-off' });

    // 2. Override creative to 'dry-run' → immediately reflected in /tools and dispatchCreativeTool.
    const dryRunRes = await request(app).put('/api/cos/config').send({ domainAutonomy: { creative: 'dry-run' } });
    expect(dryRunRes.status).toBe(200);
    expect(dryRunRes.body.domainAutonomy.creative).toBe('dry-run');
    expect((await request(app).get('/api/creative-director/tools')).body.mode).toBe('dry-run');
    expect(await dispatchCreativeTool('pipeline_createSeries', { name: 'S' })).toMatchObject({ ok: true, planned: true, mode: 'dry-run' });
    expect(createSeriesMock).not.toHaveBeenCalled();

    // 3. Unrelated domainAutonomy save must NOT strip creative.
    const unrelatedRes = await request(app).put('/api/cos/config').send({ domainAutonomy: { brain: 'off' } });
    expect(unrelatedRes.status).toBe(200);
    expect(unrelatedRes.body.domainAutonomy).toMatchObject({ brain: 'off', cos: 'off', creative: 'dry-run' });

    // 4. Override creative to 'execute' → immediately executes tool even though cos is 'off'.
    const execRes = await request(app).put('/api/cos/config').send({ domainAutonomy: { creative: 'execute' } });
    expect(execRes.status).toBe(200);
    expect(execRes.body.domainAutonomy.creative).toBe('execute');
    expect((await request(app).get('/api/creative-director/tools')).body.mode).toBe('execute');
    expect(await dispatchCreativeTool('pipeline_createSeries', { name: 'S' })).toMatchObject({ ok: true, mode: 'execute' });
    expect(createSeriesMock).toHaveBeenCalledTimes(1);

    // 5. Clear creative with null → key omitted again, mode reverts to inheriting cos ('off').
    const clearRes = await request(app).put('/api/cos/config').send({ domainAutonomy: { creative: null } });
    expect(clearRes.status).toBe(200);
    expect('creative' in clearRes.body.domainAutonomy).toBe(false);
    expect((await request(app).get('/api/cos/config')).body.domainAutonomy.creative).toBeUndefined();
    expect((await request(app).get('/api/creative-director/tools')).body.mode).toBe('off');
    expect(await dispatchCreativeTool('pipeline_createSeries', { name: 'S' })).toMatchObject({ ok: false, reason: 'autonomy-off' });
  });

  it('rejects invalid domainAutonomy.creative values and non-nullable core domains with HTTP 400', async () => {
    const badCreative = await request(app).put('/api/cos/config').send({ domainAutonomy: { creative: 'bogus' } });
    expect(badCreative.status).toBe(400);

    const nullCoreDomain = await request(app).put('/api/cos/config').send({ domainAutonomy: { cos: null } });
    expect(nullCoreDomain.status).toBe(400);
  });
});
