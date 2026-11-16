import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/lmStudioManager.js', () => ({
  unloadModel: vi.fn(),
}));

import * as lmStudioManager from '../services/lmStudioManager.js';
import lmstudioRoutes from './lmstudio.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/lmstudio', lmstudioRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('lmstudio routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();
  });

  describe('POST /api/lmstudio/unload', () => {
    it('surfaces manager failures as an unsuccessful request', async () => {
      lmStudioManager.unloadModel.mockResolvedValue({ success: false, error: 'model is busy' });

      const res = await request(app).post('/api/lmstudio/unload').send({ modelId: 'example/model' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('model is busy');
    });

    it('returns a successful unload result', async () => {
      lmStudioManager.unloadModel.mockResolvedValue({ success: true, modelId: 'example/model' });

      const res = await request(app).post('/api/lmstudio/unload').send({ modelId: 'example/model' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, modelId: 'example/model' });
    });

    it('rejects a missing model id', async () => {
      const res = await request(app).post('/api/lmstudio/unload').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.unloadModel).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['get', '/status'], ['get', '/models'], ['post', '/download'], ['post', '/load'],
    ['post', '/completion'], ['post', '/analyze-task'], ['post', '/classify-memory'],
    ['post', '/embeddings'], ['put', '/config'],
  ])('no longer serves %s %s', async (method, path) => {
    expect((await request(app)[method](`/api/lmstudio${path}`)).status).toBe(404);
  });
});
