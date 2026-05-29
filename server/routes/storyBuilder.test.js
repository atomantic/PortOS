import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the conductor service — this test verifies routing, validation, and
// service dispatch, not the service logic (covered by storyBuilder.test.js).
const svc = {
  listStorySessions: vi.fn(async () => [{ id: 'stb-1' }]),
  getStorySessionView: vi.fn(async () => ({ session: { id: 'stb-1', title: 'X' }, staleSteps: ['readerMap'] })),
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
  ERR_NOT_FOUND: 'STORY_BUILDER_NOT_FOUND',
  ERR_VALIDATION: 'STORY_BUILDER_VALIDATION',
};
vi.mock('../services/storyBuilder.js', () => svc);

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
  it('flattens the session with the computed staleSteps', async () => {
    const res = await request(makeApp()).get('/api/story-builder/stb-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('stb-1');
    expect(res.body.staleSteps).toEqual(['readerMap']);
  });

  it('maps a service NOT_FOUND to 404', async () => {
    svc.getStorySessionView.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: svc.ERR_NOT_FOUND }));
    const res = await request(makeApp()).get('/api/story-builder/stb-x');
    expect(res.status).toBe(404);
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

  it('generates and refines a step', async () => {
    const g = await request(makeApp()).post('/api/story-builder/stb-1/steps/readerMap/generate').send({});
    expect(g.status).toBe(200);
    expect(svc.generateStep).toHaveBeenCalledWith('stb-1', 'readerMap', expect.any(Object));
    const r = await request(makeApp()).post('/api/story-builder/stb-1/steps/readerMap/refine').send({ feedback: 'tighter' });
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual(['c']);
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
