import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const { runs, patchRunMetadata } = vi.hoisted(() => {
  const runs = new Map();
  return {
    runs,
    patchRunMetadata: vi.fn(async (id, patch) => Object.assign(runs.get(id), patch)),
  };
});

vi.mock('../../services/runner.js', () => ({
  getRun: vi.fn(async (id) => runs.get(id) || null),
  listRuns: vi.fn(),
  patchRunMetadata,
}));
vi.mock('../../services/providers.js', () => ({ getAllProviders: vi.fn() }));
vi.mock('../../services/pipeline/series.js', () => ({
  AUTOPILOT_LLM_STAGE_KINDS: ['foundationGate'],
  getSeries: vi.fn(async (id) => ({ id })),
}));
vi.mock('../../services/pipeline/seriesAutopilot.js', () => ({}));
vi.mock('../../services/pipeline/editorialScore.js', () => ({ READINESS_GATES: ['story'] }));
vi.mock('./shared.js', () => ({
  mapServiceError: (err) => err,
  providerOverrideShape: {},
}));

const autopilotRoutes = (await import('./autopilot.js')).default;
const app = express();
app.use(express.json());
app.use('/api/pipeline', autopilotRoutes);
app.use(errorMiddleware);

const runId = '11111111-1111-4111-8111-111111111111';
const outcome = {
  runId, role: 'creative', stage: 'foundationGate', outcome: 'accepted',
  effort: 'max', scoreBefore: 0.4, scoreAfter: 0.8,
};

beforeEach(() => {
  runs.clear();
  patchRunMetadata.mockClear();
  runs.set(runId, { id: runId, seriesId: 'series-a', qualityOutcome: 'rejected' });
});

describe('Series autopilot model outcomes', () => {
  it('refuses another series run without changing its evidence', async () => {
    const original = { ...runs.get(runId), seriesId: 'series-b' };
    runs.set(runId, { ...original });
    const res = await request(app)
      .post('/api/pipeline/series/series-a/autopilot/model-outcomes').send(outcome);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
    expect(patchRunMetadata).not.toHaveBeenCalled();
    expect(runs.get(runId)).toEqual(original);
  });

  it('records an outcome on the series own run', async () => {
    const res = await request(app)
      .post('/api/pipeline/series/series-a/autopilot/model-outcomes').send(outcome);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, runId });
    expect(runs.get(runId)).toMatchObject({
      seriesId: 'series-a', qualityOutcome: 'accepted', effort: 'max',
      qualityScoreBefore: 0.4, qualityScoreAfter: 0.8, qualityScoreDelta: 0.4,
      pipelineRole: 'creative', pipelineStage: 'foundationGate',
      qualityEvaluatedAt: expect.any(String),
    });
  });

  it.each(['missing', 'unowned'])('refuses a %s run without writing evidence', async (kind) => {
    if (kind === 'missing') runs.delete(runId);
    else delete runs.get(runId).seriesId;
    const res = await request(app)
      .post('/api/pipeline/series/series-a/autopilot/model-outcomes').send(outcome);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
    expect(patchRunMetadata).not.toHaveBeenCalled();
  });
});
