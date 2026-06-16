import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

// In-memory settings store the route's updateSettingsWith mutates.
let settingsStore = {};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => settingsStore),
  updateSettingsWith: vi.fn(async (mutate) => {
    settingsStore = await mutate(settingsStore);
    return settingsStore;
  }),
}));

// Series resolution — resolve known ids, reject the rest with a NOT_FOUND code
// that mapServiceError turns into a 404.
vi.mock('../../services/pipeline/series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSeries: vi.fn(async (id) => {
    if (id === 'missing') throw Object.assign(new Error('nope'), { code: 'PIPELINE_SERIES_NOT_FOUND' });
    return { id };
  }),
}));
vi.mock('../../services/pipeline/issues.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getIssue: vi.fn(async (id) => ({ id })),
}));

const startEditorialChecksRun = vi.fn(() => ({ runId: 'run-1', alreadyRunning: false }));
vi.mock('../../services/pipeline/editorial/checkRunner.js', () => ({
  startEditorialChecksRun: (...a) => startEditorialChecksRun(...a),
  attachClient: vi.fn(() => false),
  isEditorialChecksActive: vi.fn(() => false),
  cancelEditorialChecks: vi.fn(() => true),
}));

const editorialRoutes = (await import('./editorial.js')).default;

const app = express();
app.use(express.json());
app.use('/api/pipeline', editorialRoutes);
app.use(errorMiddleware);

beforeEach(() => {
  settingsStore = {};
  startEditorialChecksRun.mockClear();
});

describe('GET /api/pipeline/editorial/checks', () => {
  it('returns the merged check catalog', async () => {
    const res = await request(app).get('/api/pipeline/editorial/checks');
    expect(res.status).toBe(200);
    const ids = res.body.checks.map((c) => c.id);
    expect(ids).toContain('naming.dissimilar-names');
    expect(ids).toContain('prose.info-dumping');
    expect(res.body.checks.every((c) => typeof c.enabled === 'boolean')).toBe(true);
  });
});

describe('PATCH /api/pipeline/editorial/checks/:id', () => {
  it('persists an enable/disable toggle', async () => {
    const res = await request(app)
      .patch('/api/pipeline/editorial/checks/prose.info-dumping')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('prose.info-dumping');
    expect(res.body.enabled).toBe(false);
    expect(settingsStore.pipelineEditorialChecks.checks['prose.info-dumping'].enabled).toBe(false);
  });

  it('does not clobber a sibling check on a second patch', async () => {
    await request(app).patch('/api/pipeline/editorial/checks/prose.info-dumping').send({ enabled: false });
    await request(app).patch('/api/pipeline/editorial/checks/naming.dissimilar-names').send({ enabled: false });
    expect(settingsStore.pipelineEditorialChecks.checks['prose.info-dumping'].enabled).toBe(false);
    expect(settingsStore.pipelineEditorialChecks.checks['naming.dissimilar-names'].enabled).toBe(false);
  });

  it('validates config against the check schema (400 on bad config)', async () => {
    const res = await request(app)
      .patch('/api/pipeline/editorial/checks/naming.dissimilar-names')
      .send({ config: { minSharedSignals: 99 } });
    expect(res.status).toBe(400);
  });

  it('404s an unknown check id', async () => {
    const res = await request(app).patch('/api/pipeline/editorial/checks/nope.nope').send({ enabled: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/pipeline/series/:id/editorial/checks/run', () => {
  it('starts a run and returns an sseUrl', async () => {
    const res = await request(app).post('/api/pipeline/series/s1/editorial/checks/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe('run-1');
    expect(res.body.sseUrl).toContain('/editorial/checks/run/progress');
    expect(startEditorialChecksRun).toHaveBeenCalledWith('s1', expect.any(Object));
  });

  it('404s a missing series', async () => {
    const res = await request(app).post('/api/pipeline/series/missing/editorial/checks/run').send({});
    expect(res.status).toBe(404);
    expect(startEditorialChecksRun).not.toHaveBeenCalled();
  });
});
