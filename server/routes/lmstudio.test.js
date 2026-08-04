import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/lmStudioManager.js', () => ({
  getStatus: vi.fn(),
  checkLMStudioAvailable: vi.fn(),
  getLoadedModels: vi.fn(),
  getRecommendedThinkingModel: vi.fn(),
  downloadModel: vi.fn(),
  loadModel: vi.fn(),
  unloadModel: vi.fn(),
  quickCompletion: vi.fn(),
  getEmbeddings: vi.fn(),
  updateConfig: vi.fn(),
  resetCache: vi.fn()
}));

vi.mock('../services/localThinking.js', () => ({
  getStats: vi.fn(),
  analyzeTask: vi.fn(),
  classifyMemory: vi.fn()
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

  describe('PUT /api/lmstudio/config', () => {
    it('rejects a malformed baseUrl instead of persisting it', async () => {
      const res = await request(app)
        .put('/api/lmstudio/config')
        .send({ baseUrl: 'not-a-url' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.updateConfig).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric timeout', async () => {
      const res = await request(app)
        .put('/api/lmstudio/config')
        .send({ timeout: 'soon' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.updateConfig).not.toHaveBeenCalled();
    });

    it('accepts a valid config payload and forwards it to the manager', async () => {
      lmStudioManager.updateConfig.mockReturnValue({
        baseUrl: 'http://localhost:1234',
        timeout: 30000,
        defaultThinkingModel: 'qwen-14b'
      });

      const res = await request(app)
        .put('/api/lmstudio/config')
        .send({ baseUrl: 'http://localhost:1234', timeout: 30000, defaultThinkingModel: 'qwen-14b' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(lmStudioManager.updateConfig).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:1234',
        timeout: 30000,
        defaultThinkingModel: 'qwen-14b'
      });
    });

    it('accepts an empty payload (all fields optional)', async () => {
      lmStudioManager.updateConfig.mockReturnValue({ baseUrl: 'http://localhost:1234' });

      const res = await request(app).put('/api/lmstudio/config').send({});

      expect(res.status).toBe(200);
      expect(lmStudioManager.updateConfig).toHaveBeenCalledWith({
        baseUrl: undefined,
        timeout: undefined,
        defaultThinkingModel: undefined
      });
    });
  });

  describe('POST /api/lmstudio/download', () => {
    it('rejects a missing modelId', async () => {
      const res = await request(app).post('/api/lmstudio/download').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.downloadModel).not.toHaveBeenCalled();
    });

    it('rejects a non-string modelId', async () => {
      const res = await request(app).post('/api/lmstudio/download').send({ modelId: 42 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.downloadModel).not.toHaveBeenCalled();
    });

    it('forwards a valid modelId', async () => {
      lmStudioManager.downloadModel.mockResolvedValue({ success: true });
      const res = await request(app).post('/api/lmstudio/download').send({ modelId: 'qwen-14b' });
      expect(res.status).toBe(200);
      expect(lmStudioManager.downloadModel).toHaveBeenCalledWith('qwen-14b');
    });
  });

  describe('POST /api/lmstudio/completion', () => {
    it('rejects a missing prompt', async () => {
      const res = await request(app).post('/api/lmstudio/completion').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(lmStudioManager.quickCompletion).not.toHaveBeenCalled();
    });

    it('forwards a valid prompt', async () => {
      lmStudioManager.quickCompletion.mockResolvedValue({ text: 'ok' });
      const res = await request(app).post('/api/lmstudio/completion').send({ prompt: 'hello' });
      expect(res.status).toBe(200);
      expect(lmStudioManager.quickCompletion).toHaveBeenCalledWith('hello', expect.any(Object));
    });
  });
});
