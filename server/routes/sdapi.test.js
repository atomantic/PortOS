import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(),
}));

vi.mock('../services/imageGen/index.js', () => ({
  generateImage: vi.fn(),
  getMode: vi.fn(),
  getActiveJob: vi.fn(),
  local: { listImageModels: vi.fn(() => [{ id: 'dev', name: 'Flux 1 Dev' }]) },
}));

// Use a real EventEmitter so listeners attached by the route actually fire
// when the test calls `imageGenEvents.emit(...)`. The factory body is hoisted,
// so the EventEmitter has to be created INSIDE the factory.
vi.mock('../services/imageGenEvents.js', async () => {
  const { EventEmitter } = await import('events');
  return { imageGenEvents: new EventEmitter() };
});

vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => []),
  defaultVideoModelId: vi.fn(() => 'ltx_video'),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { images: '/mock/images' },
}));

import { getSettings } from '../services/settings.js';
import * as imageGen from '../services/imageGen/index.js';
import { imageGenEvents as realEmitter } from '../services/imageGenEvents.js';
import { readFile } from 'fs/promises';
import sdapiRoutes from './sdapi.js';

const enabled = () => getSettings.mockResolvedValue({ imageGen: { expose: { a1111: true } } });
const disabled = () => getSettings.mockResolvedValue({ imageGen: { expose: { a1111: false } } });

describe('sdapi routes — A1111-compatible surface', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/sdapi/v1', sdapiRoutes);
    vi.clearAllMocks();
  });

  describe('gating', () => {
    it('returns 403 on every endpoint when expose.a1111 is false', async () => {
      disabled();
      const r1 = await request(app).get('/sdapi/v1/options');
      const r2 = await request(app).get('/sdapi/v1/sd-models');
      const r3 = await request(app).get('/sdapi/v1/progress');
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
      expect(r3.status).toBe(403);
      expect(r1.body.error).toMatch(/disabled/i);
    });

    it('lets through when expose.a1111 is true', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
    });
  });

  describe('GET /options', () => {
    it('returns local model name when mode is local', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
      expect(r.body.sd_model_checkpoint).toBe('portos-local-dev');
      expect(r.body.portos.mode).toBe('local');
    });

    it('returns external stub when mode is external', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
      expect(r.body.sd_model_checkpoint).toBe('portos-external');
    });
  });

  describe('GET /progress', () => {
    it('returns idle payload when no active job', async () => {
      enabled();
      imageGen.getActiveJob.mockResolvedValue(null);
      const r = await request(app).get('/sdapi/v1/progress');
      expect(r.status).toBe(200);
      expect(r.body.progress).toBe(0);
      expect(r.body.current_image).toBeNull();
      expect(r.body.textinfo).toMatch(/no active/i);
    });

    it('passes through active job progress + step + currentImage', async () => {
      enabled();
      imageGen.getActiveJob.mockResolvedValue({
        progress: 0.42,
        step: 5,
        totalSteps: 12,
        currentImage: 'BASE64DATA',
        mode: 'local',
        modelId: 'dev',
      });
      const r = await request(app).get('/sdapi/v1/progress');
      expect(r.status).toBe(200);
      expect(r.body.progress).toBe(0.42);
      expect(r.body.state.sampling_step).toBe(5);
      expect(r.body.state.sampling_steps).toBe(12);
      expect(r.body.current_image).toBe('BASE64DATA');
      expect(r.body.textinfo).toContain('local');
      expect(r.body.textinfo).toContain('dev');
    });
  });

  describe('POST /txt2img', () => {
    it('rejects missing prompt with VALIDATION_ERROR', async () => {
      enabled();
      const r = await request(app).post('/sdapi/v1/txt2img').send({ width: 512 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/validation/i);
    });

    it('rejects out-of-range width', async () => {
      enabled();
      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat', width: 99999 });
      expect(r.status).toBe(400);
    });

    it('happy path — external mode reads file and returns base64', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      imageGen.generateImage.mockResolvedValue({
        generationId: 'g-1', filename: 'g-1.png', path: '/data/images/g-1.png',
        mode: 'external', model: 'sd-1.5', seed: 1234,
      });
      readFile.mockResolvedValue(Buffer.from([1, 2, 3]));

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat', width: 512, height: 512 });

      expect(r.status).toBe(200);
      expect(r.body.images).toHaveLength(1);
      expect(r.body.images[0]).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      const info = JSON.parse(r.body.info);
      expect(info.seed).toBe(1234);
      expect(info.portos.mode).toBe('external');
    });

    it('500s when generation completes but file is missing', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      imageGen.generateImage.mockResolvedValue({
        generationId: 'g-2', filename: 'g-2.png', path: '/data/images/g-2.png',
        mode: 'external', model: 'sd-1.5', seed: 1,
      });
      readFile.mockResolvedValue(null);

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat' });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/could not be read/i);
    });

    it('local mode waits for completion event before reading file (uses event seed)', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      // generateImage in local mode resolves as soon as the python child is
      // spawned; fire the 'completed' event from within the mock to simulate
      // the python child finishing later. Real EventEmitter wired above
      // means the route's listener will actually receive it.
      imageGen.generateImage.mockImplementation(async () => {
        const result = {
          generationId: 'g-3', filename: 'g-3.png', path: '/data/images/g-3.png',
          mode: 'local', model: 'dev', seed: 99,
        };
        // Defer the emit so the route has a chance to register the id.
        setImmediate(() => realEmitter.emit('completed', { generationId: 'g-3', seed: 4242 }));
        return result;
      });
      readFile.mockResolvedValue(Buffer.from('png'));

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'fire' });
      expect(r.status).toBe(200);
      const info = JSON.parse(r.body.info);
      // The completed event's seed wins over result.seed.
      expect(info.seed).toBe(4242);
    });
  });
});
