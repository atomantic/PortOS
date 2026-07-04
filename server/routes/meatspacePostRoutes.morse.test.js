import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Mock only the morse service — the other POST services this router imports are
// unused by these routes, but the module graph still loads them, so stub the
// morse one and let the rest import normally.
vi.mock('../services/meatspacePostMorse.js', () => ({
  appendMorseRound: vi.fn(),
  getMorseProgress: vi.fn(),
  setKochLevel: vi.fn(),
}));

import * as morseService from '../services/meatspacePostMorse.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('POST /api/meatspace/post/morse/rounds', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    morseService.appendMorseRound.mockResolvedValue({ id: 'r1', accuracy: 50 });
  });

  it('validates and delegates a well-formed round', async () => {
    const r = await request(app)
      .post('/api/meatspace/post/morse/rounds')
      .send({ mode: 'copy', kochLevel: 5, items: [{ sent: 'K', guessed: 'R', correct: false }] });
    expect(r.status).toBe(201);
    expect(morseService.appendMorseRound).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'copy', items: expect.any(Array) }),
    );
  });

  it('rejects an unknown mode', async () => {
    const r = await request(app)
      .post('/api/meatspace/post/morse/rounds')
      .send({ mode: 'telepathy', items: [{ sent: 'K', correct: true }] });
    expect(r.status).toBe(400);
    expect(morseService.appendMorseRound).not.toHaveBeenCalled();
  });

  it('rejects a round with no items', async () => {
    const r = await request(app)
      .post('/api/meatspace/post/morse/rounds')
      .send({ mode: 'copy', items: [] });
    expect(r.status).toBe(400);
  });

  it('rejects a malformed item (missing sent)', async () => {
    const r = await request(app)
      .post('/api/meatspace/post/morse/rounds')
      .send({ mode: 'copy', items: [{ guessed: 'R', correct: false }] });
    expect(r.status).toBe(400);
  });

  it('rejects an over-large items array', async () => {
    const items = Array.from({ length: 201 }, () => ({ sent: 'K', guessed: 'K', correct: true }));
    const r = await request(app)
      .post('/api/meatspace/post/morse/rounds')
      .send({ mode: 'copy', items });
    expect(r.status).toBe(400);
    expect(morseService.appendMorseRound).not.toHaveBeenCalled();
  });
});

describe('GET /api/meatspace/post/morse/progress', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    morseService.getMorseProgress.mockResolvedValue({ days: 30, kochLevel: 2, totalRounds: 0 });
  });

  it('defaults to a 30-day window', async () => {
    const r = await request(app).get('/api/meatspace/post/morse/progress');
    expect(r.status).toBe(200);
    expect(morseService.getMorseProgress).toHaveBeenCalledWith(30);
  });

  it('clamps days to the 365 ceiling', async () => {
    await request(app).get('/api/meatspace/post/morse/progress?days=9999');
    expect(morseService.getMorseProgress).toHaveBeenCalledWith(365);
  });

  it('treats days=0 (all-time) as no cutoff', async () => {
    await request(app).get('/api/meatspace/post/morse/progress?days=0');
    expect(morseService.getMorseProgress).toHaveBeenCalledWith(0);
  });
});

describe('PUT /api/meatspace/post/morse/level', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    morseService.setKochLevel.mockResolvedValue({ kochLevel: 9, kochLevelSet: true, adopted: true });
  });

  it('delegates an adopt request', async () => {
    const r = await request(app)
      .put('/api/meatspace/post/morse/level')
      .send({ kochLevel: 9, adopt: true });
    expect(r.status).toBe(200);
    expect(morseService.setKochLevel).toHaveBeenCalledWith(
      expect.objectContaining({ kochLevel: 9, adopt: true }),
    );
  });

  it('rejects a missing kochLevel', async () => {
    const r = await request(app).put('/api/meatspace/post/morse/level').send({ adopt: true });
    expect(r.status).toBe(400);
    expect(morseService.setKochLevel).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range level', async () => {
    const r = await request(app).put('/api/meatspace/post/morse/level').send({ kochLevel: 99 });
    expect(r.status).toBe(400);
  });
});
