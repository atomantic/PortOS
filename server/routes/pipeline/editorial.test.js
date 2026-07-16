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

// Voice-fingerprint service (#2194) — stub the read so the route test exercises
// the series-resolve + param-validation wiring without the manuscript store.
const getVoiceFingerprint = vi.fn(async (seriesId) => {
  if (seriesId === 'missing') throw Object.assign(new Error('nope'), { code: 'PIPELINE_SERIES_NOT_FOUND' });
  return { seriesId, gatedOff: false, issueCount: 5, threshold: 1.5, columns: [], wells: [], matrix: { issues: [] }, series: {}, outliers: [] };
});
vi.mock('../../services/pipeline/voiceFingerprint.js', () => ({
  getVoiceFingerprint: (...a) => getVoiceFingerprint(...a),
}));

const startEditorialChecksRun = vi.fn(() => ({ runId: 'run-1', alreadyRunning: false }));
const previewCustomCheck = vi.fn(async () => ({ findings: [{ severity: 'medium', problem: 'x' }], skipped: false, invalid: false }));
vi.mock('../../services/pipeline/editorial/checkRunner.js', () => ({
  startEditorialChecksRun: (...a) => startEditorialChecksRun(...a),
  previewCustomCheck: (...a) => previewCustomCheck(...a),
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

// Holistic series-review service (#2664) — stub so the route test exercises the
// param-validation + series-resolve wiring without running the composed passes.
const startSeriesReviewRun = vi.fn(() => ({ runId: 'rev-1', alreadyRunning: false }));
const getSeriesReview = vi.fn(async () => ({ review: { seriesId: 'ser-1', verdict: 'issues', findings: [] }, fix: { mode: 'execute', canFix: true } }));
vi.mock('../../services/pipeline/seriesReview.js', () => ({
  startSeriesReviewRun: (...a) => startSeriesReviewRun(...a),
  getSeriesReview: (...a) => getSeriesReview(...a),
  attachClient: vi.fn(() => false),
  isSeriesReviewActive: vi.fn(() => false),
  cancelSeriesReview: vi.fn(() => true),
}));

const editorialRoutes = (await import('./editorial.js')).default;

const app = express();
app.use(express.json());
app.use('/api/pipeline', editorialRoutes);
app.use(errorMiddleware);

beforeEach(() => {
  settingsStore = {};
  startEditorialChecksRun.mockClear();
  previewCustomCheck.mockClear();
  getSeriesHealth.mockClear();
  getVoiceFingerprint.mockClear();
  startSeriesReviewRun.mockClear();
  getSeriesReview.mockClear();
});

describe('Holistic "Review this series" (#2664)', () => {
  it('POST /series/:id/review starts a run and returns the SSE url', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/ser-1/review')
      .send({ feedback: 'volume 1 has no real development' });
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe('rev-1');
    expect(res.body.sseUrl).toBe('/api/pipeline/series/ser-1/review/progress');
    expect(startSeriesReviewRun).toHaveBeenCalledWith('ser-1', expect.objectContaining({ feedback: 'volume 1 has no real development' }));
  });

  it('POST /series/:id/review threads provider/model/readinessGate overrides', async () => {
    await request(app)
      .post('/api/pipeline/series/ser-1/review')
      .send({ providerId: 'openai', model: 'gpt-x', readinessGate: 'noOpenHighOrMedium' });
    expect(startSeriesReviewRun).toHaveBeenCalledWith('ser-1', expect.objectContaining({
      providerOverride: 'openai', modelOverride: 'gpt-x', readinessGate: 'noOpenHighOrMedium',
    }));
  });

  it('POST /series/:id/review 400s on an invalid readiness gate', async () => {
    const res = await request(app).post('/api/pipeline/series/ser-1/review').send({ readinessGate: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('POST /series/:id/review 404s for a missing series', async () => {
    const res = await request(app).post('/api/pipeline/series/missing/review').send({});
    expect(res.status).toBe(404);
    expect(startSeriesReviewRun).not.toHaveBeenCalled();
  });

  it('GET /series/:id/review returns the stored verdict + fix availability', async () => {
    const res = await request(app).get('/api/pipeline/series/ser-1/review');
    expect(res.status).toBe(200);
    expect(res.body.review.verdict).toBe('issues');
    expect(res.body.fix).toEqual({ mode: 'execute', canFix: true });
  });

  it('GET /series/:id/review/status reports active=false when no run is in flight', async () => {
    const res = await request(app).get('/api/pipeline/series/ser-1/review/status');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe('GET /api/pipeline/series/:id/voice-fingerprint (#2194)', () => {
  it('returns the fingerprint matrix payload for a known series', async () => {
    const res = await request(app).get('/api/pipeline/series/ser-1/voice-fingerprint');
    expect(res.status).toBe(200);
    expect(res.body.seriesId).toBe('ser-1');
    expect(res.body.gatedOff).toBe(false);
    expect(getVoiceFingerprint).toHaveBeenCalledWith('ser-1');
  });

  it('404s for a missing series (mapped from the service NOT_FOUND code)', async () => {
    const res = await request(app).get('/api/pipeline/series/missing/voice-fingerprint');
    expect(res.status).toBe(404);
  });
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

  it('persists a severity override and surfaces it on the resolved row (#1596)', async () => {
    const res = await request(app)
      .patch('/api/pipeline/editorial/checks/naming.dissimilar-names')
      .send({ severity: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.severity).toBe('high');
    expect(res.body.severityOverride).toBe('high');
    expect(settingsStore.pipelineEditorialChecks.checks['naming.dissimilar-names'].severity).toBe('high');
  });

  it('clears a severity override on null (falls back to the registry default)', async () => {
    await request(app).patch('/api/pipeline/editorial/checks/naming.dissimilar-names').send({ severity: 'high' });
    const res = await request(app)
      .patch('/api/pipeline/editorial/checks/naming.dissimilar-names')
      .send({ severity: null });
    expect(res.status).toBe(200);
    expect(res.body.severityOverride).toBeNull();
    expect(res.body.severity).toBe(res.body.severityDefault);
    expect(settingsStore.pipelineEditorialChecks.checks['naming.dissimilar-names'].severity).toBeUndefined();
  });

  it('rejects an out-of-enum severity (400)', async () => {
    const res = await request(app)
      .patch('/api/pipeline/editorial/checks/naming.dissimilar-names')
      .send({ severity: 'critical' });
    expect(res.status).toBe(400);
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

describe('POST /api/pipeline/series/:id/editorial/custom-checks/preview (#1607)', () => {
  const draft = { label: 'Anachronisms', prompt: 'Flag modern tech.' };

  it('returns sample findings for a valid draft and forwards overrides to the runner', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/s1/editorial/custom-checks/preview')
      .send({ ...draft, providerId: 'ollama', model: 'm', maxFindings: 5 });
    expect(res.status).toBe(200);
    expect(res.body.findings).toHaveLength(1);
    // The provider/model/maxFindings split off the def and forward as runner opts.
    const [seriesId, def, opts] = previewCustomCheck.mock.calls[0];
    expect(seriesId).toBe('s1');
    expect(def).toMatchObject({ label: 'Anachronisms', prompt: 'Flag modern tech.' });
    expect(def.providerId).toBeUndefined();
    expect(opts).toMatchObject({ providerOverride: 'ollama', modelOverride: 'm', maxFindings: 5 });
  });

  it('404s an unknown series before running the check', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/missing/editorial/custom-checks/preview')
      .send(draft);
    expect(res.status).toBe(404);
    expect(previewCustomCheck).not.toHaveBeenCalled();
  });

  it('400s a draft missing the required prompt', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/s1/editorial/custom-checks/preview')
      .send({ label: 'No prompt' });
    expect(res.status).toBe(400);
    expect(previewCustomCheck).not.toHaveBeenCalled();
  });
});

describe('editorial health (#1316)', () => {
  it('GET .../editorial/health returns the health payload with the default gate', async () => {
    const res = await request(app).get('/api/pipeline/series/s1/editorial/health');
    expect(res.status).toBe(200);
    expect(res.body.seriesId).toBe('s1');
    expect(res.body.score).toBe(100);
    // No gate configured → service called with the default.
    // #1616: the route also threads the series' merged severity weights (the mock
    // series carries no override → the frozen defaults).
    expect(getSeriesHealth).toHaveBeenCalledWith('s1', { gate: 'noOpenHigh', weights: { high: 12, medium: 5, low: 1 } });
  });

  it('GET .../editorial/health resolves the configured gate from settings', async () => {
    await request(app).patch('/api/pipeline/editorial/readiness-gate').send({ readinessGate: 'noOpenHighOrMedium' });
    await request(app).get('/api/pipeline/series/s1/editorial/health');
    expect(getSeriesHealth).toHaveBeenLastCalledWith('s1', { gate: 'noOpenHighOrMedium', weights: { high: 12, medium: 5, low: 1 } });
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
