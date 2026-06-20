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

// Health service (#1316) — stub the read so the route test exercises the route
// wiring (series-resolve + settings-gate resolution) without the file store.
const getSeriesHealth = vi.fn(async (seriesId, opts) => ({ seriesId, score: 100, ready: true, gate: opts?.gate }));
vi.mock('../../services/pipeline/editorialScore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSeriesHealth: (...a) => getSeriesHealth(...a),
}));

const editorialRoutes = (await import('./editorial.js')).default;

const app = express();
app.use(express.json());
app.use('/api/pipeline', editorialRoutes);
app.use(errorMiddleware);

beforeEach(() => {
  settingsStore = {};
  startEditorialChecksRun.mockClear();
  getSeriesHealth.mockClear();
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

  it('400s an unknown requested check id instead of running zero checks', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/s1/editorial/checks/run')
      .send({ checkIds: ['prose.info-dumpng'] }); // typo
    expect(res.status).toBe(400);
    expect(startEditorialChecksRun).not.toHaveBeenCalled();
  });

  it('accepts a created custom check id in a targeted run', async () => {
    const created = await request(app)
      .post('/api/pipeline/editorial/custom-checks')
      .send({ label: 'Runnable', prompt: 'Find X' });
    const res = await request(app)
      .post('/api/pipeline/series/s1/editorial/checks/run')
      .send({ checkIds: [created.body.id] });
    expect(res.status).toBe(200);
    expect(startEditorialChecksRun).toHaveBeenCalled();
  });
});

describe('custom checks CRUD (#1346)', () => {
  const create = (body) => request(app).post('/api/pipeline/editorial/custom-checks').send(body);

  it('creates a custom check and returns its resolved row', async () => {
    const res = await create({ label: 'Anachronisms', prompt: 'Flag modern tech in a period setting.' });
    expect(res.status).toBe(201);
    expect(res.body.id.startsWith('custom.')).toBe(true);
    expect(res.body.isCustom).toBe(true);
    expect(res.body.kind).toBe('llm');
    expect(res.body.enabled).toBe(true);
    expect(res.body.prompt).toContain('modern tech');
    expect(settingsStore.pipelineEditorialChecks.customChecks).toHaveLength(1);
    const list = await request(app).get('/api/pipeline/editorial/checks');
    expect(list.body.checks.some((c) => c.id === res.body.id)).toBe(true);
  });

  it('400s a create with no prompt or label', async () => {
    expect((await create({ label: 'No prompt' })).status).toBe(400);
    expect((await create({ prompt: 'No label' })).status).toBe(400);
  });

  it('reuses the shared toggle path to enable/disable a custom check', async () => {
    const { body } = await create({ label: 'Toggle me', prompt: 'do thing' });
    const res = await request(app)
      .patch(`/api/pipeline/editorial/checks/${encodeURIComponent(body.id)}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(settingsStore.pipelineEditorialChecks.checks[body.id].enabled).toBe(false);
  });

  it('edits a custom check definition, preserving id/createdAt', async () => {
    const { body } = await create({ label: 'Old name', prompt: 'old prompt' });
    const createdAt = settingsStore.pipelineEditorialChecks.customChecks[0].createdAt;
    const res = await request(app)
      .patch(`/api/pipeline/editorial/custom-checks/${encodeURIComponent(body.id)}`)
      .send({ label: 'New name', severityDefault: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('New name');
    expect(res.body.severityDefault).toBe('high');
    const def = settingsStore.pipelineEditorialChecks.customChecks[0];
    expect(def.id).toBe(body.id);
    expect(def.createdAt).toBe(createdAt);
    expect(def.prompt).toBe('old prompt'); // untouched fields preserved
  });

  it('a field-specific edit leaves omitted fields unchanged (no default reset)', async () => {
    const { body } = await create({ label: 'Original', prompt: 'p', scope: 'series', category: 'continuity', description: 'keep me' });
    const res = await request(app)
      .patch(`/api/pipeline/editorial/custom-checks/${encodeURIComponent(body.id)}`)
      .send({ label: 'Renamed' }); // only label
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Renamed');
    // Omitted fields must NOT revert to schema defaults (issue/custom/'').
    expect(res.body.scope).toBe('series');
    expect(res.body.category).toBe('continuity');
    const def = settingsStore.pipelineEditorialChecks.customChecks[0];
    expect(def.scope).toBe('series');
    expect(def.category).toBe('continuity');
    expect(def.description).toBe('keep me');
  });

  it('404s editing an unknown custom id and 400s a non-custom id', async () => {
    expect((await request(app).patch('/api/pipeline/editorial/custom-checks/custom.nope').send({ label: 'x' })).status).toBe(404);
    expect((await request(app).patch('/api/pipeline/editorial/custom-checks/prose.info-dumping').send({ label: 'x' })).status).toBe(400);
  });

  it('deletes a custom check and its enable/config override', async () => {
    const { body } = await create({ label: 'Delete me', prompt: 'p' });
    await request(app).patch(`/api/pipeline/editorial/checks/${encodeURIComponent(body.id)}`).send({ enabled: false });
    const res = await request(app).delete(`/api/pipeline/editorial/custom-checks/${encodeURIComponent(body.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(settingsStore.pipelineEditorialChecks.customChecks).toHaveLength(0);
    expect(settingsStore.pipelineEditorialChecks.checks[body.id]).toBeUndefined();
  });

  it('404s deleting an unknown custom id', async () => {
    expect((await request(app).delete('/api/pipeline/editorial/custom-checks/custom.nope')).status).toBe(404);
  });
});

describe('editorial health (#1316)', () => {
  it('GET .../editorial/health returns the health payload with the default gate', async () => {
    const res = await request(app).get('/api/pipeline/series/s1/editorial/health');
    expect(res.status).toBe(200);
    expect(res.body.seriesId).toBe('s1');
    expect(res.body.score).toBe(100);
    // No gate configured → service called with the default.
    expect(getSeriesHealth).toHaveBeenCalledWith('s1', { gate: 'noOpenHigh' });
  });

  it('GET .../editorial/health resolves the configured gate from settings', async () => {
    await request(app).patch('/api/pipeline/editorial/readiness-gate').send({ readinessGate: 'noOpenHighOrMedium' });
    await request(app).get('/api/pipeline/series/s1/editorial/health');
    expect(getSeriesHealth).toHaveBeenLastCalledWith('s1', { gate: 'noOpenHighOrMedium' });
  });

  it('GET .../editorial/health 404s a missing series', async () => {
    const res = await request(app).get('/api/pipeline/series/missing/editorial/health');
    expect(res.status).toBe(404);
    expect(getSeriesHealth).not.toHaveBeenCalled();
  });

  it('PATCH .../editorial/readiness-gate persists into the editorial-checks slice', async () => {
    const res = await request(app).patch('/api/pipeline/editorial/readiness-gate').send({ readinessGate: 'none' });
    expect(res.status).toBe(200);
    expect(res.body.readinessGate).toBe('none');
    expect(settingsStore.pipelineEditorialChecks.readinessGate).toBe('none');
  });

  it('PATCH .../editorial/readiness-gate 400s an unknown gate value', async () => {
    const res = await request(app).patch('/api/pipeline/editorial/readiness-gate').send({ readinessGate: 'whenever' });
    expect(res.status).toBe(400);
  });

  it('PATCH .../editorial/readiness-gate does not clobber existing check overrides', async () => {
    await request(app).patch('/api/pipeline/editorial/checks/prose.info-dumping').send({ enabled: false });
    await request(app).patch('/api/pipeline/editorial/readiness-gate').send({ readinessGate: 'noOpenHigh' });
    expect(settingsStore.pipelineEditorialChecks.checks['prose.info-dumping'].enabled).toBe(false);
    expect(settingsStore.pipelineEditorialChecks.readinessGate).toBe('noOpenHigh');
  });
});
