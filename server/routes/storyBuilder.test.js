import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the conductor service — this test verifies routing, validation, and
// service dispatch, not the service logic (covered by storyBuilder.test.js).
const svc = {
  listStorySessions: vi.fn(async () => [{ id: 'stb-1' }]),
  getStorySessionView: vi.fn(async () => ({ session: { id: 'stb-1', title: 'X' }, staleSteps: ['readerMap'], syncDrift: true })),
  createStorySession: vi.fn(async (input) => ({ id: 'stb-new', ...input })),
  updateStorySession: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteStorySession: vi.fn(async (id) => ({ id })),
  lockStep: vi.fn(async (id, stepId) => ({ id, locked: stepId })),
  unlockStep: vi.fn(async (id, stepId) => ({ id, unlocked: stepId })),
  setCurrentStep: vi.fn(async (id, stepId) => ({ id, currentStep: stepId })),
  setIssueLock: vi.fn(async (id, issueId, locked) => ({ id, issueId, locked })),
  generateStep: vi.fn(async () => ({ result: { ok: true } })),
  refineStep: vi.fn(async () => ({ result: { ok: true }, changes: ['c'], rationale: 'r' })),
  getStorySession: vi.fn(async () => ({ id: 'stb-1' })),
  setStorySessionSync: vi.fn(async (id, sync) => ({ id, sync })),
  reconcileStorySession: vi.fn(async (id) => ({ id, sync: true, reconciled: true })),
  ERR_NOT_FOUND: 'STORY_BUILDER_NOT_FOUND',
  ERR_VALIDATION: 'STORY_BUILDER_VALIDATION',
};
vi.mock('../services/storyBuilder.js', () => svc);

// generate/refine kick off through the SSE runner; the route returns the runId +
// sseUrl and the work streams in the background. Stub the runner so the route
// test verifies dispatch + the kickoff response shape, not the run lifecycle.
const runner = {
  startStepRun: vi.fn(() => ({ runId: 'run-1', alreadyRunning: false })),
  attachClient: vi.fn(() => true),
};
vi.mock('../services/storyBuilderRunner.js', () => runner);

const { default: storyBuilderRoutes } = await import('./storyBuilder.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/story-builder', storyBuilderRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/story-builder/steps', () => {
  it('returns the ordered step manifest', async () => {
    const res = await request(makeApp()).get('/api/story-builder/steps');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps[0].id).toBe('idea');
    expect(res.body.steps.find((s) => s.id === 'readerMap')).toBeTruthy();
  });
});

describe('GET /api/story-builder', () => {
  it('returns the full sessions array by default', async () => {
    const res = await request(makeApp()).get('/api/story-builder');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns a bounded envelope when pagination is requested', async () => {
    svc.listStorySessions.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `stb-${i}` }))
    );
    const res = await request(makeApp()).get('/api/story-builder?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].id).toBe('stb-1');
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('POST /api/story-builder', () => {
  it('creates a session (201) and dispatches to the service', async () => {
    const res = await request(makeApp()).post('/api/story-builder').send({ title: 'Salt Run', seedIdea: 'seed' });
    expect(res.status).toBe(201);
    expect(svc.createStorySession).toHaveBeenCalledWith(expect.objectContaining({ title: 'Salt Run' }));
  });

  it('rejects a missing title with 400', async () => {
    const res = await request(makeApp()).post('/api/story-builder').send({ seedIdea: 'x' });
    expect(res.status).toBe(400);
    expect(svc.createStorySession).not.toHaveBeenCalled();
  });

  it('rejects unknown fields (strict schema)', async () => {
    const res = await request(makeApp()).post('/api/story-builder').send({ title: 'X', bogus: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/story-builder/:id', () => {
  it('flattens the session with the computed staleSteps and syncDrift flag', async () => {
    const res = await request(makeApp()).get('/api/story-builder/stb-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('stb-1');
    expect(res.body.staleSteps).toEqual(['readerMap']);
    expect(res.body.syncDrift).toBe(true);
  });

  it('maps a service NOT_FOUND to 404', async () => {
    svc.getStorySessionView.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: svc.ERR_NOT_FOUND }));
    const res = await request(makeApp()).get('/api/story-builder/stb-x');
    expect(res.status).toBe(404);
  });
});

describe('cross-machine resume routes (#730)', () => {
  it('POST /:id/sync toggles sync, dispatches to the service, and returns the recomputed view', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/sync').send({ sync: true });
    expect(res.status).toBe(200);
    expect(svc.setStorySessionSync).toHaveBeenCalledWith('stb-1', true);
    // Toggling sync can shift staleness, so the route returns the flattened view
    // (staleSteps + syncDrift) — not the bare record — for a reactive merge.
    expect(svc.getStorySessionView).toHaveBeenCalledWith('stb-1');
    expect(res.body.staleSteps).toEqual(['readerMap']);
    expect(res.body.syncDrift).toBe(true);
  });

  it('POST /:id/sync rejects a missing sync flag with 400', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/sync').send({});
    expect(res.status).toBe(400);
    expect(svc.setStorySessionSync).not.toHaveBeenCalled();
  });

  it('POST /:id/reconcile re-baselines, dispatches to the service, and returns the recomputed view', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/reconcile').send({});
    expect(res.status).toBe(200);
    expect(svc.reconcileStorySession).toHaveBeenCalledWith('stb-1');
    // Reconcile moves the baseline → staleSteps recompute; the route returns the
    // flattened view so the client updates the step rail without a refetch.
    expect(svc.getStorySessionView).toHaveBeenCalledWith('stb-1');
    expect(res.body.staleSteps).toEqual(['readerMap']);
    expect(res.body.syncDrift).toBe(true);
  });

  it('maps a reconcile VALIDATION error (local-only session) to 400', async () => {
    svc.reconcileStorySession.mockRejectedValueOnce(Object.assign(new Error('off'), { code: svc.ERR_VALIDATION }));
    const res = await request(makeApp()).post('/api/story-builder/stb-1/reconcile').send({});
    expect(res.status).toBe(400);
  });
});

describe('step state machine routes', () => {
  it('locks a valid step', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/steps/plotArc/lock').send({});
    expect(res.status).toBe(200);
    expect(svc.lockStep).toHaveBeenCalledWith('stb-1', 'plotArc');
  });

  it('rejects an unknown step id with 400 before touching the service', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/steps/bogus/lock').send({});
    expect(res.status).toBe(400);
    expect(svc.lockStep).not.toHaveBeenCalled();
  });

  it('advances the current step', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/current-step/universeAesthetic').send({});
    expect(res.status).toBe(200);
    expect(svc.setCurrentStep).toHaveBeenCalledWith('stb-1', 'universeAesthetic');
  });

  it('kicks off a generate run and returns the runId + sseUrl', async () => {
    const g = await request(makeApp()).post('/api/story-builder/stb-1/steps/readerMap/generate').send({});
    expect(g.status).toBe(200);
    expect(runner.startStepRun).toHaveBeenCalledWith('stb-1', 'readerMap', expect.objectContaining({ op: 'generate' }));
    expect(g.body.runId).toBe('run-1');
    expect(g.body.sseUrl).toBe('/api/story-builder/stb-1/steps/readerMap/progress');
  });

  it('kicks off a refine run with the validated feedback', async () => {
    const r = await request(makeApp()).post('/api/story-builder/stb-1/steps/readerMap/refine').send({ feedback: 'tighter' });
    expect(r.status).toBe(200);
    expect(runner.startStepRun).toHaveBeenCalledWith('stb-1', 'readerMap', expect.objectContaining({ op: 'refine', feedback: 'tighter' }));
    expect(r.body.sseUrl).toBe('/api/story-builder/stb-1/steps/readerMap/progress');
  });

  it('404s a kickoff for a missing session before starting a run', async () => {
    svc.getStorySession.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: svc.ERR_NOT_FOUND }));
    const res = await request(makeApp()).post('/api/story-builder/stb-x/steps/readerMap/generate').send({});
    expect(res.status).toBe(404);
    expect(runner.startStepRun).not.toHaveBeenCalled();
  });

  it('rejects an unknown step id on the progress stream with 400', async () => {
    const res = await request(makeApp()).get('/api/story-builder/stb-1/steps/bogus/progress');
    expect(res.status).toBe(400);
    expect(runner.attachClient).not.toHaveBeenCalled();
  });

  it('404s the progress stream when no run is active', async () => {
    runner.attachClient.mockReturnValueOnce(false);
    const res = await request(makeApp()).get('/api/story-builder/stb-1/steps/readerMap/progress');
    expect(res.status).toBe(404);
  });
});

describe('per-issue lock route', () => {
  it('locks an issue', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/issues/iss-1/lock').send({ locked: true });
    expect(res.status).toBe(200);
    expect(svc.setIssueLock).toHaveBeenCalledWith('stb-1', 'iss-1', true);
  });

  it('requires the locked boolean', async () => {
    const res = await request(makeApp()).post('/api/story-builder/stb-1/issues/iss-1/lock').send({});
    expect(res.status).toBe(400);
  });
});
