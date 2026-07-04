import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Scoped to the busiest untested handler: POST /post/drill (issue #2102 gap 4).
// Mock every service the route dispatches to so this file exercises ONLY the
// route's own branching (LLM cache-first, memory- prefix-strip dispatch,
// adaptive/progression attachment on math, and the three ServerError throws) —
// the services themselves already have dedicated unit coverage elsewhere.
vi.mock('../services/meatspacePostDrillCache.js', () => ({
  // postValidation.js's postDrillCacheFillSchema enum-validates against this.
  CACHEABLE_TYPES: ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'],
  getCacheStats: vi.fn(() => ({})),
  requestCacheFill: vi.fn(),
  getCachedDrill: vi.fn(() => null),
  triggerReplenish: vi.fn(),
}));

vi.mock('../services/meatspacePostLlm.js', () => ({
  generateLlmDrill: vi.fn(),
  scoreLlmDrill: vi.fn(),
}));

vi.mock('../services/meatspacePostMemory.js', () => ({
  generateMemoryDrill: vi.fn(),
}));

vi.mock('../services/meatspacePost.js', () => ({
  resolveDrillConfig: vi.fn(),
  generateDrill: vi.fn(),
  getPostReviewReps: vi.fn(),
}));

import { getCachedDrill, triggerReplenish } from '../services/meatspacePostDrillCache.js';
import { generateLlmDrill } from '../services/meatspacePostLlm.js';
import { generateMemoryDrill } from '../services/meatspacePostMemory.js';
import { resolveDrillConfig, generateDrill, getPostReviewReps } from '../services/meatspacePost.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('POST /api/meatspace/post/drill', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // LLM drill types — cache-first branch
  // ===========================================================================

  describe('LLM drill types', () => {
    it('serves from cache when a pre-generated drill is available, and triggers a replenish', async () => {
      const cached = { type: 'word-association', config: { count: 5 }, questions: [{ prompt: 'cathedral' }] };
      getCachedDrill.mockReturnValue(cached);

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'word-association', config: {}, providerId: 'prov-1', model: 'model-1' });

      expect(r.status).toBe(200);
      expect(r.body).toEqual(cached);
      expect(getCachedDrill).toHaveBeenCalledWith('word-association');
      expect(triggerReplenish).toHaveBeenCalledWith('word-association', 'prov-1', 'model-1');
      expect(generateLlmDrill).not.toHaveBeenCalled();
    });

    it('falls through to live generation on a cold cache, and still triggers a replenish', async () => {
      getCachedDrill.mockReturnValue(null);
      const generated = { type: 'word-association', config: { count: 5 }, questions: [{ prompt: 'river' }] };
      generateLlmDrill.mockResolvedValue(generated);

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'word-association', config: { count: 5 } });

      expect(r.status).toBe(200);
      expect(r.body).toEqual(generated);
      expect(generateLlmDrill).toHaveBeenCalledWith('word-association', { count: 5 }, undefined, undefined);
      expect(triggerReplenish).toHaveBeenCalledWith('word-association', undefined, undefined);
    });

    it('throws LLM_DRILL_FAILED when generation returns nothing', async () => {
      getCachedDrill.mockReturnValue(null);
      generateLlmDrill.mockResolvedValue(null);

      const r = await request(app).post('/api/meatspace/post/drill').send({ type: 'word-association', config: {} });

      expect(r.status).toBe(500);
      expect(r.body.code).toBe('LLM_DRILL_FAILED');
      expect(triggerReplenish).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Memory drill types — `memory-` prefix-strip dispatch
  // ===========================================================================

  describe('Memory drill types', () => {
    it('strips the memory- prefix into `mode` and forwards count/memoryItemId', async () => {
      const drill = { type: 'memory-sequence', memoryItemId: 'song-1', questions: [] };
      generateMemoryDrill.mockResolvedValue(drill);

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'memory-sequence', config: { count: 3, memoryItemId: 'song-1' } });

      expect(r.status).toBe(200);
      expect(r.body).toEqual(drill);
      expect(generateMemoryDrill).toHaveBeenCalledWith({ mode: 'sequence', count: 3, memoryItemId: 'song-1' });
    });

    it('throws MEMORY_DRILL_FAILED when no drill can be generated', async () => {
      generateMemoryDrill.mockResolvedValue(null);

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'memory-element-flash', config: {} });

      expect(r.status).toBe(500);
      expect(r.body.code).toBe('MEMORY_DRILL_FAILED');
    });
  });

  // ===========================================================================
  // Math / cognitive drill types — adaptive + progressive-ladder attachment
  // ===========================================================================

  describe('Math/cognitive drill types', () => {
    it('generates via the resolved effective config and attaches an adaptive explainer when present', async () => {
      resolveDrillConfig.mockResolvedValue({
        config: { steps: 10 },
        adaptive: { applied: true, reason: 'harder', field: 'steps' },
        progression: null,
      });
      generateDrill.mockReturnValue({ type: 'doubling-chain', config: { steps: 10 }, questions: [{ prompt: '4 x 2', expected: 8 }] });

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'doubling-chain', config: { steps: 8 } });

      expect(r.status).toBe(200);
      expect(resolveDrillConfig).toHaveBeenCalledWith('doubling-chain', { steps: 8 });
      expect(generateDrill).toHaveBeenCalledWith('doubling-chain', { steps: 10 });
      expect(r.body.adaptive).toEqual({ applied: true, reason: 'harder', field: 'steps' });
      expect(r.body.progression).toBeUndefined();
    });

    it('attaches a progression explainer for the progressive multiplication ladder', async () => {
      resolveDrillConfig.mockResolvedValue({
        config: { count: 10, level: 1, factors: [1, 2] },
        adaptive: null,
        progression: { level: 1, floorLevel: 1 },
      });
      generateDrill.mockReturnValue({ type: 'multiplication', config: { level: 1 }, questions: [] });

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'multiplication', config: { count: 10 } });

      expect(r.status).toBe(200);
      expect(r.body.progression).toEqual({ level: 1, floorLevel: 1 });
      expect(r.body.adaptive).toBeUndefined();
    });

    it('omits both explainers when neither adaptive nor progression ran', async () => {
      resolveDrillConfig.mockResolvedValue({ config: { steps: 8 }, adaptive: null });
      generateDrill.mockReturnValue({ type: 'doubling-chain', config: { steps: 8 }, questions: [] });

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'doubling-chain', config: {} });

      expect(r.status).toBe(200);
      expect(r.body.adaptive).toBeUndefined();
      expect(r.body.progression).toBeUndefined();
    });

    it('throws INVALID_DRILL_TYPE when the generator returns nothing for a recognized-but-unhandled type', async () => {
      resolveDrillConfig.mockResolvedValue({ config: {}, adaptive: null });
      generateDrill.mockReturnValue(null);

      const r = await request(app).post('/api/meatspace/post/drill')
        .send({ type: 'n-back', config: {} });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_DRILL_TYPE');
    });
  });

  // ===========================================================================
  // Request validation
  // ===========================================================================

  it('rejects an unknown drill type at the validation layer', async () => {
    const r = await request(app).post('/api/meatspace/post/drill').send({ type: 'not-a-real-type', config: {} });
    expect(r.status).toBe(400);
    expect(resolveDrillConfig).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Maintenance-review reps (issue #2096)
// =============================================================================

describe('POST /api/meatspace/post/drill — review re-stamp', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('re-stamps review markers from the resolved config onto the generated drill', async () => {
    // The generators rebuild their own config and drop review/reviewSkillId, so
    // the route must re-attach them for the session-submit tie-back.
    resolveDrillConfig.mockResolvedValue({
      config: { count: 5, level: 0, factors: [1, 1], review: true, reviewSkillId: 'multiplication:L0' },
      adaptive: null,
      progression: null,
    });
    generateDrill.mockReturnValue({ type: 'multiplication', config: { count: 5, factors: [1, 1], level: 0 }, questions: [] });

    const r = await request(app).post('/api/meatspace/post/drill').send({
      type: 'multiplication',
      config: { review: true, reviewSkillId: 'multiplication:L0', level: 0, factors: [1, 1] },
    });
    expect(r.status).toBe(200);
    expect(r.body.config.review).toBe(true);
    expect(r.body.config.reviewSkillId).toBe('multiplication:L0');
    expect(r.body.isReview).toBe(true);
  });
});

describe('GET /api/meatspace/post/review/reps', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('returns the due maintenance reps under a { reps } envelope', async () => {
    getPostReviewReps.mockResolvedValue([{ skillId: 'multiplication:L0', label: 'Multiplication 1×1-digit', type: 'multiplication', config: {} }]);
    const r = await request(app).get('/api/meatspace/post/review/reps');
    expect(r.status).toBe(200);
    expect(r.body.reps).toHaveLength(1);
    expect(getPostReviewReps).toHaveBeenCalledWith(expect.any(Date), 2);
  });

  it('clamps the limit query param to 0..5', async () => {
    getPostReviewReps.mockResolvedValue([]);
    await request(app).get('/api/meatspace/post/review/reps?limit=99');
    expect(getPostReviewReps).toHaveBeenCalledWith(expect.any(Date), 5);
  });
});
